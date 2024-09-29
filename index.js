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
const cloudinary = require("cloudinary").v2;
const sharp = require("sharp");

dayjs.extend(utc);
dayjs.extend(timezone);
const app = express();
app.use(express.json());
// app.use(cors({
//   origin: "https://macetas-brian.vercel.app" 
// }));
app.use(cors())

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
const argentinaTime = dayjs().tz('America/Argentina/Buenos_Aires');

const PORT = process.env.PORT || 4000;

// Cloudinary variables
const preset_name = process.env.PRESET_NAMES_IMAGES;
const cloud_name = process.env.CLOUD_NAME_IMAGES;
const cloudinary_api_key = process.env.cloudinary_api_key;
const cloudinary_api_secret = process.env.CLOUDINARY_API_SECRET;
const cloudinary_url = `https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`;
//

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME_IMAGES,  // Asegúrate de que estas variables estén definidas
  api_key: process.env.cloudinary_api_key,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const timestamp = Math.floor(Date.now() / 1000);

app.get("/", (req,res)=> {
  res.send("SERVER ON")
})

// Subir imagen a Cloudinary
const uploadToCloudinary = async (file) => {
  try {
    // Procesar la imagen con sharp para reducir el tamaño
    const optimizedImageBuffer = await sharp(file.buffer)
      .resize({
        width: 1000, // Ajusta el tamaño según sea necesario
        withoutEnlargement: true, // esto evita que se agranden las imágenes pequeñas
      })
      .toFormat('jpeg') // Cambia el formato a JPEG para mejor compresión
      .toBuffer();

    const formData = new FormData();
    formData.append("file", optimizedImageBuffer, { filename: file.originalname });
    formData.append("upload_preset", preset_name);

    const response = await axios.post(cloudinary_url, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });

    return response.data.secure_url;
  } catch (error) {
    console.error("Error subiendo imagen:", error);
    throw new Error("Falló la subida a Cloudinary");
  }
};

// Extraer ID público de la URL de la imagen
const extractPublicIdFromUrl = (url) => {
  console.log(url)
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
  console.log("PublicId", publicId)
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
  console.log("ID del producto: ",productId)
  const { productCategory, productDescription, productName, productPrice, imagesToDelete } = req.body;
  const imagesToDeleteArray = JSON.parse(imagesToDelete || '[]'); 
  console.log(imagesToDeleteArray)
  const newImages = req.files || [];  
  let newImageUrls = [];

  try {
    await client.query('BEGIN');

    // Actualización del producto
    const updateProductQuery = `
      UPDATE products 
      SET id_product_category = $1, description = $2, name = $3, price = $4 
      WHERE id_product = $5;
    `;
    const updateProductResult = await client.query(updateProductQuery, [
      productCategory, productDescription, productName, productPrice, productId
    ]);

    if (updateProductResult.rowCount === 0) throw new Error("No se pudo actualizar el producto");

    // Eliminación de imágenes anteriores
    if (imagesToDeleteArray.length > 0) {
      const publicIds = imagesToDeleteArray.map((img) => extractPublicIdFromUrl(img.image_url));
      console.log(publicIds);
      await Promise.all(publicIds.map(async (publicId) => await deleteImageFromCloudinary(publicId)));

      const deleteOldImagesQuery = `DELETE FROM product_images WHERE id_image = ANY($1::int[])`;
      const idsToDelete = imagesToDeleteArray.map(img => img.id_image);
      
      await client.query(deleteOldImagesQuery, [idsToDelete]);
      
    }

    if (newImages.length > 0) {
      newImageUrls = await Promise.all(
        newImages.map(async (image) => await uploadToCloudinary(image))
      );

      const insertImageQuery = `INSERT INTO product_images (id_product_image, image_url) VALUES ($1, $2);`;
      await Promise.all(
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
  const query5 = "SELECT * FROM banners"
  const query6 = "SELECT * FROM ajustes"


  try {
    const [result1, result2, result3, result4, result5, result6] = await Promise.all([
      pool.query(query1),
      pool.query(query2),
      pool.query(query3),
      pool.query(query4),
      pool.query(query5),
      pool.query(query6)
    ]);    
    return res.status(200).json({
      categories: result1.rows,
      product_images: result2.rows,
      products: result3.rows,
      promotions: result4.rows,
      bannersImgs: result5.rows,
      settings: result6.rows
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

app.post("/create-promotion", upload.single("promoImage"), async (req, res) => {
  const client = await pool.connect();
  const { productsIDs, promoName, promoPrice, startDate, endDate, enabled } = req.body;
  const file = req.file;

  const query = `INSERT INTO promotions(id_product_promotion, name, price, start_date, end_date, enabled, "imageUrl") VALUES($1, $2, $3, $4, $5, $6, $7)`;
  let imageUrl = []
  try {
    await client.query("BEGIN");

    imageUrl = await uploadToCloudinary(file);

    const response = await client.query(query, [productsIDs, promoName, promoPrice, startDate, endDate, enabled, imageUrl]);

    if (response.rowCount === 0) {
      await client.query("ROLLBACK");
      const publicId = extractPublicIdFromUrl(imageUrl);
      await deleteImageFromCloudinary(publicId);
      return res.status(400).json({ message: "Error al guardar la promoción" });
    }

    await client.query("COMMIT");
    return res.status(200).json({ message: `Promoción guardada y lista para activarse el ${startDate}` });
  } catch (error) {
    console.log(error);

    await client.query("ROLLBACK");
    if (file) {
      const publicId = extractPublicIdFromUrl(imageUrl);
      await deleteImageFromCloudinary(publicId);
    }
    return res.status(500).json({ message: "Error interno del servidor: No se pudo guardar la promoción" });
  } finally {
    client.release();
  }
});


app.post("/update-promotion", upload.single("promoImage"), async (req, res) => {
  const client = await pool.connect();
  const { productsIDs, promoName, promoPrice, startDate, endDate, enabled, promotionID, existingImage, imageToDelete } = req.body;
  const file = req.file;
  let imageUrl = [];

  const query = `UPDATE promotions SET id_product_promotion = $1, name = $2, price = $3, start_date = $4, end_date = $5, enabled = $6, "imageUrl" = $7 WHERE id_promotion = $8`;

  try {
    await client.query("BEGIN");

    // Si hay una imagen existente, solo actualiza la promoción sin cambiar la imagen
    if (existingImage) {
      const response = await client.query(query, [productsIDs, promoName, promoPrice, startDate, endDate, enabled, existingImage, promotionID]);
      if (response.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Error al actualizar la promoción" });
      }
      await client.query("COMMIT");
      return res.status(200).json({ message: "Promoción actualizada" });
    }

    // Si no hay una imagen existente, elimina la imagen anterior (si corresponde)
    const publicId = extractPublicIdFromUrl(imageToDelete);
    const responseImages = await deleteImageFromCloudinary(publicId);
    if (responseImages.code !== "ok" && responseImages.code !== 200) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Error al eliminar la imagen anterior" });
    }

    // Subir la nueva imagen
    if (!file) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No se encontró ninguna imagen para subir" });
    }

    imageUrl = await uploadToCloudinary(file);
    if (!imageUrl) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Error al subir la nueva imagen" });
    }

    // Actualizar la promoción con la nueva imagen
    const response = await client.query(query, [productsIDs, promoName, promoPrice, startDate, endDate, enabled, imageUrl, promotionID]);
    if (response.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Error al actualizar la promoción" });
    }

    await client.query("COMMIT");
    return res.status(200).json({ message: "Promoción actualizada" });

  } catch (error) {
    console.log(error);
    // Intentar eliminar las imágenes subidas en caso de error
    try {
      await Promise.all(imageUrl.map(async (url) => {
        const publicId = extractPublicIdFromUrl(url);
        await deleteImageFromCloudinary(publicId);
      }));
    } catch (err) {
      console.error("Error al eliminar imágenes subidas:", err);
    }
    await client.query("ROLLBACK");
    return res.status(500).json({ message: "Error interno del servidor: No se pudo actualizar la promoción" });
  } finally {
    client.release();
  }
});


app.delete("/delete-promotion/:promotionID",upload.none(), async(req,res)=> {
  const client = await pool.connect()
  const promotionID = req.params.promotionID
  const {imageUrl} = req.query
  const query = `DELETE FROM promotions WHERE id_promotion = $1`
  try {
    const publicId = extractPublicIdFromUrl(imageUrl);
    const responseImages = await deleteImageFromCloudinary(publicId);
    console.log("Respuesta al eliminar: ",responseImages)
    if (responseImages.code === "ok" || responseImages.code === 200) {
      const response = await client.query(query,[promotionID])
      if (response.rowCount === 0) {
        return res.status(400).json({message: "Error al eliminar la promoción"})
      }
      return res.status(200).json({message: "Promoción eliminada!"})
    }
    return res.status(400).json({message: "Error al eliminar la promoción"})

    
  } catch (error) {
    console.log(error)
    return res.status(500).json({message: "Error interno del servidor: No se pudo eliminar la promoción"})
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
  const query = "DELETE FROM promotions WHERE end_date = $1";
  const argentinaTime = dayjs().tz("America/Argentina/Buenos_Aires");
  const values = [argentinaTime.format("YYYY-MM-DD")];

  try {
    const response = await client.query(query, values);
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


app.get("/get-usages", async (req, res) => {
  try {
    const cloudinaryUsage = await cloudinary.api.usage();
    const querySupabase = `SELECT pg_size_pretty(pg_database_size(current_database())) AS total_size;
`
    const result = await pool.query(querySupabase);
    console.log(result);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No se encontró espacio disponible para este usuario" });
    }

    const availableSpace = result.rows;

    return res.status(200).json({
      cloudinaryUsage,
      availableSpace
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "No se pudo obtener el uso de Cloudinary o el espacio en Supabase" });
  }
});

app.post("/clean-db", async(req,res)=> {
  const client = await pool.connect()
  try {
    const query = "VACUUM FULL"
    const response = await client.query(query)
    return res.status(200).json({message: "Limpieza de la BD exitosa!", response})
  } catch (error) {
    console.log(error)
    return res.status(500).json({message:"Hubo un error al hacer la limpieza de la BD"})
  }finally{
    client.release()
  }
});

app.get("/get_products_view", async (req, res) => {
  const client = await pool.connect();
  try {
    const query1 = "SELECT * FROM products";
    const query2 = "SELECT * FROM product_images";
    const query3 = "SELECT * FROM categories";
    const query4 = "SELECT * FROM promotions";
    const query5 = "SELECT * FROM ajustes";
    const query6 = "SELECT * FROM banners";

    const [rp1, rp2, rp3, rp4,rp5,rp6] = await Promise.all([
      client.query(query1),
      client.query(query2),
      client.query(query3),
      client.query(query4),
      client.query(query5),
      client.query(query6)
    ]);

    res.json({
      products: rp1.rows,
      productImages: rp2.rows,
      categories: rp3.rows,
      promotions: rp4.rows,
      settings: rp5.rows,
      bannersImgs: rp6.rows
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Hubo un error al hacer la limpieza de la BD" });
  } finally {
    client.release();
  }
});

app.post("/update_setting", async(req,res)=> {
  const client = await pool.connect()
  const { condition_promotion, condition_product } = req.body
  const query = `UPSERT INTO ajustes (condition_promotion, condition_product) VALUES ($1, $2) `

  try {
    const response = await client.query(query, [condition_promotion, condition_product])
    return res.status(200).json({message: "Ajustes actualizados!", response})
  } catch (error) {
    console.log(error)
    return res.status(500).json({message:"Hubo un error al hacer la actualización"})
  }finally{
    client.release()
  }
})

app.post("/upload_banner", upload.array("bannerImages"), async (req, res) => {
  const client = await pool.connect();
  let imageUrls = [];
  const productImages = req.files;
  console.log(productImages)
  const {bannerName} = req.body
  try {
    await client.query('BEGIN');
    
    imageUrls = await Promise.all(
      productImages.map(async (image) => await uploadToCloudinary(image))
    );
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      const serializedURLS = JSON.stringify(imageUrls);
      const insertProductQuery = `INSERT INTO banners(image_urls, nombre_banner) VALUES($1, $2)`;
      const productResponse = await client.query(insertProductQuery, [serializedURLS, bannerName]);
      if (productResponse.rowCount === 0){
        await client.query('ROLLBACK');
        return res.status(400).json({message: "No se pudieron insertar el/los banner/s",productResponse})
      }else{
        await client.query('COMMIT');
        res.status(200).json({ message: "Banner subido correctamente" });
      }
    }else{
      await client.query("ROLLBACK")
      return res.status(400).json({message: "No se pudieron insertar el/los banner/s"})
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error al procesar el producto:", error);

    // Eliminación de imágenes subidas en caso de error
    await Promise.all(imageUrls.map(async (imageUrl) => {
      const publicId = extractPublicIdFromUrl(imageUrl);
      await deleteImageFromCloudinary(publicId);
    }));

    res.status(500).json({ success: false, message: "Error al subir el banner", error });
  } finally {
    client.release();
  }

  return res.status(200).send()
});

app.delete("/delete_banner/:id", async (req, res) => {
  const client = await pool.connect();
  const bannerId = req.params.id;
  const imagenUrl = req.body.imageUrl
  const publicId = extractPublicIdFromUrl(imagenUrl)
  try {
    const responseDelete = await deleteImageFromCloudinary(publicId)
    console.log(responseDelete)
    if (responseDelete.code === "ok" || responseDelete.code === 200) {
      const deleteBannerQuery = "DELETE FROM banners WHERE id = $1";
      const response = await client.query(deleteBannerQuery, [bannerId]);
      if (response.rowCount > 0) {
        res.status(200).json({ message: "Banner eliminado correctamente" });
      }else{
        res.status(400).json({ message: "Error al eliminar el banner" });
      }
    }else{
      return res.status(400).json({message: "Error al eliminar las imagenes, por favor intente nuevamente"})
    }
  } catch (error) {
    console.error("Error al eliminar el banner:", error);
    res.status(500).json({ success: false, message: "Error al eliminar el banner" });
  } finally {
    client.release();
  }

  res.status(200).send()
})

app.put("/update_settings", async(req,res)=> {
  const value = req.body.values
  const client = await pool.connect()
  const query = `UPDATE ajustes SET page_enabled = $1 WHERE id = 1` 

  try {
    const response = await client.query(query, [value])
    if (response.rowCount > 0) {
      return res.status(200).json({message: "Ajustes actualizados!"})
    }else{
      return res.status(400).json({message: "Error al actualizar los ajustes"})
    }
  } catch (error) {
    console.log(error)
    return res.status(500).json({message:"Hubo un error al hacer la actualización"})
  }finally{
    client.release()
  }
  // return res.status(200).json({message: "Ajustes actualizados!"})
})

app.put("/update_product_state",upload.none(), async(req,res)=> {
  const client = await pool.connect()
  const {productId, is_available} = req.body
  const query = `UPDATE products SET is_available = $1 WHERE id_product = $2` 
  try {
    const response = await client.query(query, [is_available, productId])
    if (response.rowCount > 0) {
      return res.status(200).json({message: "Estado del producto actualizado!"})
    }else{
      return res.status(400).json({message: "Error intentando actualizar el estado del producto"})
    }
  } catch (error) {
    console.log(error)
    return res.status(500).json({message:"Hubo un error en el servidor intentando hacer la actualización del estado del producto"})
  }finally{
    client.release()
  }
})

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
