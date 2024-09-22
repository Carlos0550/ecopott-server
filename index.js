const express = require("express");
const cors = require("cors");
const pool = require("./DB/clientSupabase");
const axios = require("axios");
const FormData = require("form-data");
const multer = require("multer");
const crypto = require("crypto");
const cron = require("node-cron")
const dayjs = require('dayjs');
const utc = require("dayjs/plugin/utc");
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const upload = multer({ storage: multer.memoryStorage() });
const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');

const PORT = process.env.PORT || 4000;

// Cloudinary variables
const preset_name = process.env.PRESET_NAMES_IMAGES;
const cloud_name = process.env.CLOUD_NAME_IMAGES;
const cloudinary_api_key = process.env.cloudinary_api_key;
const cloudinary_api_secret = process.env.CLOUDINARY_API_SECRET;
const cloudinary_url = `https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`;
//
const timestamp = Math.floor(Date.now() / 1000);

app.get("/", (req,res)=> {
  res.send("SERVER ON")
})

// Subir imagen a Cloudinary
const uploadToCloudinary = async (file) => {
  const formData = new FormData();
  formData.append("file", file.buffer, { filename: file.originalname });
  formData.append("upload_preset", preset_name);

  try {
    const response = await axios.post(cloudinary_url, formData, {
      headers: formData.getHeaders(),
    });
    return response.data.secure_url;
  } catch (error) {
    console.error("Error subiendo imagen:", error);
    throw new Error("Error al subir imagen");
  }
};

// Extraer ID público de la URL de la imagen
const extractPublicIdFromUrl = (url) => {
  const parts = url.split('/');
  const fileName = parts.pop();
  return fileName.split('.')[0];
};

// Generar firma para la solicitud de eliminación
const generateSignature = (publicId, timestamp, apiSecret) => {
  return crypto.createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');
};

// Eliminar imagen de Cloudinary
const deleteImageFromCloudinary = async (publicId) => {
  const signature = generateSignature(publicId, timestamp, cloudinary_api_secret);

  try {
    const response = await axios.post(
      `https://api.cloudinary.com/v1_1/${cloud_name}/image/destroy`,
      `public_id=${publicId}&signature=${signature}&api_key=${cloudinary_api_key}&timestamp=${timestamp}`, 
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    
    if (response.data.result === 'ok') {
      console.log(response.data)
      return { code: 200 };
    } else {
      throw new Error(`Error al eliminar imagen: ${response.data}`);
    }
  } catch (error) {
    console.error("Error al eliminar imagen de Cloudinary:", error);
    throw new Error("Error al eliminar imagen");
  }
};

// Ruta para subir producto
app.post("/upload-product", upload.array("productImages"), async (req, res) => {
  const client = await pool.connect();
  let imageUrls = [];
  
  try {
    await client.query('BEGIN');
  
    const { productCategory, productDescription, productName, productPrice } = req.body;
    const productImages = req.files;
  
    imageUrls = await Promise.all(
      productImages.map(async (image) => await uploadToCloudinary(image))
    );
  
    const insertProductQuery = `INSERT INTO products (id_product_category, description, name, price)
                                VALUES ($1, $2, $3, $4) RETURNING id_product;`;
    const productResponse = await client.query(insertProductQuery, [
      productCategory, productDescription, productName, productPrice
    ]);
  
    if (productResponse.rowCount === 0) throw new Error("No se pudo insertar el producto");
  
    const idProduct = productResponse.rows[0].id_product;
    const insertImageQuery = `INSERT INTO product_images (id_product_image, image_url) VALUES ($1, $2);`;

    await Promise.all(
      imageUrls.map(async (imageUrl) => 
        await client.query(insertImageQuery, [idProduct, imageUrl])
      )
    );
  
    await client.query('COMMIT');
    res.status(200).json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error al procesar el producto:", error);

    // Eliminación de imágenes subidas en caso de error
    await Promise.all(imageUrls.map(async (imageUrl) => {
      const publicId = extractPublicIdFromUrl(imageUrl);
      await deleteImageFromCloudinary(publicId);
    }));

    res.status(500).json({ success: false, message: "Error al subir el producto" });
  } finally {
    client.release();
  }
});

// Ruta para actualizar producto
app.post("/update-product/:id", upload.array("newImages"), async (req, res) => {
  const client = await pool.connect();
  const productId = req.params.id;
  const { productCategory, productDescription, productName, productPrice, imagesToDelete } = req.body;
  const imagesToDeleteArray = JSON.parse(imagesToDelete);
  const newImages = req.files;
  let newImageUrls = [];

  try {
    await client.query('BEGIN');

    // Actualización del producto
    const updateProductQuery = `
      UPDATE products SET id_product_category = $1, description = $2, name = $3, price = $4 
      WHERE id_product = $5;
    `;
    const updateProductResult = await client.query(updateProductQuery, [
      productCategory, productDescription, productName, productPrice, productId
    ]);
    
    if (updateProductResult.rowCount === 0) throw new Error("No se pudo actualizar el producto");

    // Eliminación de imágenes anteriores
    if (imagesToDeleteArray.length > 0) {
      const publicIds = imagesToDeleteArray.map((img) => extractPublicIdFromUrl(img.image_url));
      console.log(publicIds)
      await Promise.all(publicIds.map(async (publicId) => await deleteImageFromCloudinary(publicId)));
    }

    // Subida de nuevas imágenes
    if (newImages.length > 0) {
      newImageUrls = await Promise.all(
        newImages.map(async (image) => await uploadToCloudinary(image))
      );
      const deleteOldImagesQuery = `DELETE FROM product_images WHERE id_image = $1`
      const insertImageQuery = `INSERT INTO product_images (id_product_image, image_url) VALUES ($1, $2);`;
      await Promise.all(
        imagesToDeleteArray.map(async(imageUrl) => {
          await client.query(deleteOldImagesQuery,[imageUrl.id_image])
        }),
        newImageUrls.map(async (imageUrl) => 
          await client.query(insertImageQuery, [productId, imageUrl])
        )
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: "Producto actualizado correctamente" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error al actualizar el producto:", error);

    // Eliminación de imágenes subidas en caso de error
    await Promise.all(newImageUrls.map(async (imageUrl) => {
      const publicId = extractPublicIdFromUrl(imageUrl);
      await deleteImageFromCloudinary(publicId);
    }));

    res.status(500).json({ success: false, message: "Error al actualizar el producto" });
  } finally {
    client.release();
  }
});

// Ruta para eliminar producto
app.delete("/delete-product/:id", async (req, res) => {
  const client = await pool.connect();
  const productId = req.params.id;
  const productImages = req.body.images;
  const publicIds = productImages.map((image) => extractPublicIdFromUrl(image.image_url));

  try {
    await client.query('BEGIN');

    // Eliminación de imágenes en Cloudinary
    await Promise.all(
      publicIds.map(async (publicId) => await deleteImageFromCloudinary(publicId))
    );

    // Eliminación de imágenes de la base de datos
    const deleteImagesQuery = `DELETE FROM product_images WHERE id_image = $1;`;
    await Promise.all(
      productImages.map(async (image) => await client.query(deleteImagesQuery, [image.id_image]))
    );

    // Eliminación del producto
    const deleteProductQuery = `DELETE FROM products WHERE id_product = $1;`;
    const deleteProductResult = await client.query(deleteProductQuery, [productId]);

    if (deleteProductResult.rowCount === 0) throw new Error("No se pudo eliminar el producto");

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: "Producto eliminado correctamente" });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error al eliminar el producto:", error);
    res.status(500).json({ success: false, message: "Error al eliminar el producto" });
  } finally {
    client.release();
  }
});

app.get("/fetch-all-data", async(req,res)=> {
  const query1 = "SELECT * FROM CATEGORIES"
  const query2 = "SELECT * FROM product_images"
  const query3 = "SELECT * FROM products"
  const query4 = "SELECT * FROM promotions"
  const query5 = "SELECT * FROM vista_productos"

  try {
    const [result1, result2, result3, result4, result5] = await Promise.all([
      pool.query(query1),
      pool.query(query2),
      pool.query(query3),
      pool.query(query4),
      pool.query(query5),
    ]);    
    return res.status(200).json({
      categories: result1.rows,
      product_images: result2.rows,
      products: result3.rows,
      promotions: result4.rows,
      products_view: result5.rows,
    });
  } catch (error) {
    console.log(error)
    return res.status(500).json({message: "Error interno del servidor: No se pudo traer todos los datos"})
  }
});

app.post("/create-category", async(req,res)=> {
  const {categoryName, description} = req.body
  if (!categoryName) {
    return res.status(400).json({message: "El nombre de la categoría es requerido"})
  }

  const query = "INSERT INTO categories(name, description) VALUES($1,$2)"
  try {
    const response = await pool.query(query, [categoryName, description])
    if (response.rowCount > 0) {
      return res.status(200).json({message: "Categoría creada exitosamente!"})
    }else{
      return res.status(400).json({message: "Hubo un error y no se pudo crear la categoría"})
    }
  } catch (error) {
    console.log(error)
    return res.status(500).json({message: "Error interno del servidor: no se pudo crear la categoría", error})
  }
});

app.put("/update-category/:id", async(req,res)=> {
  const client = await pool.connect()

  const categoryId = req.params.id
  const { categoryName, description } = req.body.data
  // console.log(categoryId)
  // console.log(categoryName,description)

  const query = `UPDATE categories SET name = $1, description = $2 WHERE id_category = $3`
  try {
    await client.query("BEGIN")
    const response = await client.query(query,[categoryName,description,categoryId])
    if (response.rowCount > 0) {
      await client.query("COMMIT")
      return res.status(200).json({message: "Categoría actualizada"})
    }else{
      await client.query("ROLLBACK")
      return res.status(400).json({message: "Error intentando actualizar la categoría"})
    }
  } catch (error) {
    console.log(error)
    await client.query("ROLLBACK")
    return res.status(500).json({message: "Error interno del servidor: no se pudo actualizar la categoría"})
  }finally{
    client.release()
  }
})

app.delete("/delete-category/:id", async(req,res)=> {
  const client = await pool.connect()
  const categoryId = req.params.id
  const query = `DELETE FROM categories WHERE id_category = $1`
  try {
    await client.query("BEGIN")
    const response = await client.query(query,[categoryId])
    if (response.rowCount > 0) {
      await client.query("COMMIT")
      return res.status(200).json({message: "Categoría eliminada"})
    }else{
      await client.query("ROLLBACK")
      return res.status(400).json({message: "Error intentando eliminar la categoría"})
    }
  } catch (error) {
    console.log(error)
    await client.query("ROLLBACK")
    return res.status(500).json({message: "Error interno del servidor: no se pudo eliminar la categoría"})
  }finally{
    client.release()
  }
})

app.post("/create-promotion",upload.none(), async(req,res)=> {
  const client = await pool.connect()
  const { productsIDs, promoName, promoPrice, startDate, endDate, enabled } = req.body
  const arrayIDs = JSON.parse(productsIDs)
  console.log(enabled)
  let errorInserting = false
  const query = `INSERT INTO promotions(id_product_promotion, name,price, start_date, end_date, enabled) VALUES($1, $2, $3, $4, $5, $6)`
  try {
    for (let i = 0; i < arrayIDs.length; i++) {
      const response = await client.query(query,[arrayIDs[i], promoName, promoPrice, startDate, endDate, enabled])
      if (response.rowCount === 0) {
        errorInserting = true
        break
      }
    }
    if (errorInserting) {
      return res.status(400).json({message: "Error al guardar la promoción"})
    }
    return res.status(200).json({message: `Promoción guardada y lista para activarse el ${startDate}`})
  } catch (error) {
    console.log(error)
    return res.status(500).json({message: "Error interno del servidor: No se pudo guardar la promoción"})
  }finally{
    client.release()
  }
});


// cron.schedule("17 00 * * *", async () => {
//   const client = await pool.connect();
//   const query = "DELETE FROM promotions WHERE start_date = end_date";

//   try {
//     const response = await client.query(query);
//     console.log(`Promociones eliminadas: ${response.rowCount}`);
//   } catch (error) {
//     console.error("Error al eliminar promociones:", error);
//   } finally {
//     client.release(); // Liberar el cliente
//   }
// });

app.post("/automatic-delete-promotions", async (req, res) => {
  const client = await pool.connect();
  const query = "DELETE FROM promotions WHERE start_date = end_date";

  try {
    const response = await client.query(query);
    console.log(`Promociones eliminadas: ${response.rowCount}`);
    return res.status(200).json({ message: `${response.rowCount} promociones eliminadas.` });
  } catch (error) {
    console.error("Error al eliminar promociones:", error);
    return res.status(500).json({ message: "Error interno del servidor." });
  } finally {
    client.release();
  }
});

app.put("/automatic-enable-promotions", async (req, res) => {
  const client = await pool.connect();
  try {
    const argentinaTime = dayjs().tz("America/Argentina/Buenos_Aires");
    const query = `UPDATE promotions SET enabled = true WHERE start_date = $1`; 
    const values = [argentinaTime.format("YYYY-MM-DD")];

    const response = await client.query(query, values);
    return res.status(200).json({
      message: `${response.rowCount} filas fueron actualizadas`,
      query: response,
    });
  } catch (error) {
    return res.status(500).json({
      message: "No se pudo activar las promociones",
      errores: error,
    });
  } finally {
    client.release();
  }
});






app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
