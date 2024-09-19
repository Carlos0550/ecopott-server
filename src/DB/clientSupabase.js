require("dotenv").config()
const {Pool} = require("pg")

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});


(async()=>{
    try {
        const client = await pool.connect()
        console.log("Conexión exitosa a la base de datos!")
        client.release()
        console.log("Cliente liberado")
    } catch (error) {
        console.error('Error conectando a la base de datos:', error);
    }
})()

module.exports = pool;