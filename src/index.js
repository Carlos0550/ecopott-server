const express = require("express");
const cors = require("cors");
const pool = require("./DB/clientSupabase.js"); 
const axios = require("axios");
const FormData = require("form-data"); //Módulo para construir formularios con datos de archivo (necesario para subir archivos).
const multer = require("multer"); //Middleware para manejar archivos subidos en las solicitudes HTTP.
const crypto = require("crypto"); //Módulo para operaciones criptográficas, usado aquí para generar firmas
const app = express();
app.use(express.json());
app.use(cors({
  origin: "*"
}));

const upload = multer({ storage: multer.memoryStorage() }); //Configura multer para almacenar archivos en memoria (sin guardar en disco).

const PORT = process.env.PORT || 4000;

//Cloudinary variables entorno
const preset_name = process.env.PRESET_NAMES_IMAGES;
const cloud_name = process.env.CLOUD_NAME_IMAGES;
const cloudinary_api_key = process.env.CLOUDINARY_API_KEY;
const cloudinary_api_secret = process.env.CLOUDINARY_API_SECRET; // Definido correctamente como CLOUDINARY_API_SECRET
const cloudinary_url = `https://api.cloudinary.com/v1_1/${cloud_name}/image/upload`;
//
const timestamp = Math.floor(Date.now() / 1000);

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
    console.log(error)
  }
};

app.get("/", (req,res)=> {
  res.send("SERVIDOR WEB ONLINE")
})

const extractPublicIdFromUrl = (url) => { //Extrae el ID público de la URL de la imagen
  // console.log("**********************")
  // console.log("URLs recibidas para eliminar:", url)
  // console.log("**********************")
  const parts = url.split('/');
  const fileName = parts.pop();
  return fileName.split('.')[0];
};

const generateSignature = (publicId, timestamp, apiSecret) => { //Genera una firma para autenticar la solicitud de eliminación.
  const signature = crypto.createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');
  return signature;
};

const deleteImageFromCloudinary = async (publicId) => { //Envía una solicitud para eliminar una imagen de Cloudinary usando la firma generada.
  const signature = generateSignature(publicId, timestamp, cloudinary_api_secret); 

  try {
    const response = await axios.post(`https://api.cloudinary.com/v1_1/${cloud_name}/image/destroy`, 
      `public_id=${publicId}&signature=${signature}&api_key=${cloudinary_api_key}&timestamp=${timestamp}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    if (response.data.result === 'ok') {
      console.log(`Imagen ${publicId} eliminada correctamente.`);
      return {code: 200}
    } else {
      console.log(`Error al eliminar imagen ${publicId}: ${response.data}`);
    }
  } catch (error) {
    console.error("Error al eliminar imagen de Cloudinary:", error);
    console.log(error)
  }
};

app.post("/upload-product", upload.array("productImages"), async (req, res) => { 
    const client = await pool.connect();
    let imageUrls = [];
    try {
      await client.query('BEGIN');
  
      const { productCategory, productDescription, productName, productPrice } = req.body;
      const productImages = req.files;
  
      imageUrls = await Promise.all(
        productImages.map(async (image) => {
          return await uploadToCloudinary(image);
        })
      );
  
      const insertQuery1 = `INSERT INTO products (id_product_category, description, name, price)
                            VALUES ($1, $2, $3, $4)
                            RETURNING id_product;`;
      const response1 = await client.query(insertQuery1, [
        productCategory,
        productDescription,
        productName,
        productPrice,
      ]);
  
      if (response1.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: "No se pudo insertar el producto" });
        return;
      }
  
      const idProduct = response1.rows[0].id_product;
  
      const insertQuery2 = `INSERT INTO product_images (id_product_image, image_url)
                            VALUES ($1, $2);`;
  
      const response2 = await Promise.all(
        imageUrls.map(async (imageUrl) => {
          return await client.query(insertQuery2, [idProduct, imageUrl]);
        })
      );
  
      const allImagesInserted = response2.every(res => res.rowCount > 0);
  
      if (!allImagesInserted) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: "No se pudieron insertar todas las imágenes" });
        return;
      }
  
      await client.query('COMMIT');
      res.status(200).json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK'); 
  
      for (const imageUrl of imageUrls) {
        const publicId = extractPublicIdFromUrl(imageUrl);
        await deleteImageFromCloudinary(publicId);
      }
  
      console.error("Error al procesar el producto:", error);
      res.status(500).json({ success: false, message: "Error al subir el producto" });
    } finally {
      client.release();
    }
  });
  

app.post("/create-category", async(req,res)=> {
    const {categoryName, description} = req.body
    if (!categoryName) {
      return res.status(400).json({message: "El nombre de la categoría es requerido"})
    }

    const query = `INSERT INTO categories(name, description) VALUES($1,$2)`
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

app.get("/fetch-all-data", async(req,res)=> {
  const query1 = `SELECT * FROM CATEGORIES`
  const query2 = `SELECT * FROM product_images`
  const query3 = `SELECT * FROM products`
  const query4 = `SELECT * FROM promotions`
  const query5 = `SELECT * FROM vista_productos`

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

app.post("/update-product/:id", upload.array("newImages"), async (req, res) => {
  const client = await pool.connect();
  const productId = req.params.id; 
  const { productCategory, productDescription, productName, productPrice, imagesToDelete } = req.body;
  const imagesToDeleteArray = JSON.parse(imagesToDelete);
  const newImages = req.files;
  let responseUpload = [];
  try {
    await client.query('BEGIN');

    const updateQuery = `
      UPDATE products 
      SET id_product_category = $1, description = $2, name = $3, price = $4 
      WHERE id_product = $5;
    `;
    const updateValues = [productCategory, productDescription, productName, productPrice, productId];
    const updateResult = await client.query(updateQuery, updateValues);

    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: "No se pudo actualizar el producto" });
    }

    if (newImages.length > 0) {
        const publicIds = imagesToDeleteArray.map((img) => extractPublicIdFromUrl(img.image_url));

      await Promise.all(publicIds.map(async (publicId) => {
        await deleteImageFromCloudinary(publicId);
      }));

      responseUpload = await Promise.all(
        newImages.map(async (image) => {
          return await uploadToCloudinary(image);
        })
      );

      if (responseUpload.length === 0) {
        return res.status(500).json({message: "Error interno del servidor: No se pudieron actualizar las imagenes"})
      }
    }


    const insertImagesQuery = `
      INSERT INTO product_images (id_product_image, image_url) 
      VALUES ($1, $2);
    `;

    const removeOldImagesQuery = `DELETE FROM product_images WHERE id_image = $1`

    const removeOldImagesFromDB = await Promise.all(
      imagesToDeleteArray.map(async (image) => {
        return await client.query(removeOldImagesQuery,[image.id_image])
      })
    )

    if(removeOldImagesFromDB.rowCount === 0){
      await client.query("ROLLBACK")
      return res.status(400).json({message: "Hubo un error al actualizar el producto en la BD"})
    }

    const insertImagesResults = await Promise.all(
      responseUpload.map(async (imageUrl) => {
        return await client.query(insertImagesQuery, [productId, imageUrl]);
      })
    );

    const allImagesInserted = insertImagesResults.every(res => res.rowCount > 0);

    if (!allImagesInserted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: "No se pudieron insertar todas las imágenes" });
    }

    await client.query('COMMIT');
    return res.status(200).json({ success: true, message: "Producto actualizado correctamente" });
  } catch (error) {
    const parsedPublicsId = responseUpload.map((item)=> extractPublicIdFromUrl(item))
    
    await Promise.all(parsedPublicsId.map(async (publicId) => {
      await deleteImageFromCloudinary(publicId);
    }));
    await client.query('ROLLBACK'); 

    
    console.error("Error al actualizar el producto:", error);

    return res.status(500).json({ success: false, message: "Error al actualizar el producto" });
  } finally {
    client.release(); 
  }
  
});

app.delete("/delete-product/:id", async(req,res)=> {
  const client = await pool.connect()
  const productID = req.params.id
  const productImages = req.body.images
  const publicIDs = productImages.map((images) => extractPublicIdFromUrl(images.image_url))

  const deleteQuery1 = `DELETE FROM product_images WHERE id_image = $1`
  const deleteQuery2 = `DELETE FROM products WHERE id_product = $1`

  try {
    await client.query("BEGIN")
    const responseDeleteImgFromCloudinary = await Promise.all(
      publicIDs.map(async(images)=> {
        return await deleteImageFromCloudinary(images)
      })
    )
    if (responseDeleteImgFromCloudinary[0].code !== 200) return res.status(500).json({message: "Hubo un error al eliminar las imagenes del producto"})

    const result1 = productImages.map(async(image)=> {
      return await client.query(deleteQuery1,[image.id_image])
    })

    if (result1.rowCount === 0){
      await client.query("ROLLBACK")
    }

    const result2 = await client.query(deleteQuery2,[productID])
    if (result2.rowCount === 0){
      await client.query("ROLLBACK")
      return res.status(400).json({message:"Hubo un error al intentar eliminar el producto"})
    }
    await client.query("COMMIT")
    return res.status(200).json({message: "Producto eliminado exitosamente!"})
  } catch (error) {
    await client.query("ROLLBACK")
    return res.status(500).json({message: "Error interno del servidor: No se pudo eliminar el producto"})
  } finally{
    client.release()
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



app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
