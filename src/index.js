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
    console.error("Error subiendo imagen:", error.response?.data || error.message);
    throw error;
  }
};

const extractPublicIdFromUrl = (url) => { //Extrae el ID público de la URL de la imagen
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
  const timestamp = Math.floor(Date.now() / 1000);
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
    } else {
      console.log(`Error al eliminar imagen ${publicId}: ${response.data}`);
    }
  } catch (error) {
    console.error("Error al eliminar imagen de Cloudinary:", error);
    throw error;
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
    const {categoryName} = req.body

})

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
