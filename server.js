const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Configuración de middlewares
app.use(cors()); // Permite peticiones desde el frontend (file:// o localhost)
app.use(express.json({ limit: '10mb' })); // Permitir cargas grandes porque el JSON podría incluir imágenes base64

// Cadena de conexión a MongoDB Atlas
const MONGO_URI = 'mongodb+srv://jobchallenger2025_db_user:gwGyPVQRbLMxWUx1@cluster0.sewhio3.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB Atlas exitosamente'))
  .catch((err) => console.error('❌ Error conectando a MongoDB Atlas:', err));

// Definir el esquema y modelo para el tráfico/tareas
// Guardaremos todo el array de tareas en un solo documento para mayor simplicidad según los requerimientos
const traficoSchema = new mongoose.Schema({
  docId: { type: String, default: 'main', unique: true },
  tasks: { type: Array, default: [] },
  lastUpdated: { type: Date, default: Date.now }
});

const Trafico = mongoose.model('Trafico', traficoSchema);

// GET /api/trafico - Cargar datos
app.get('/api/trafico', async (req, res) => {
  try {
    let document = await Trafico.findOne({ docId: 'main' });
    
    // Si no existe, enviamos un array vacío
    if (!document) {
      return res.json([]);
    }
    
    res.json(document.tasks || []);
  } catch (error) {
    console.error('Error obteniendo el tráfico:', error);
    res.status(500).json({ error: 'Error del servidor al obtener datos' });
  }
});

// POST /api/trafico - Guardar datos (sobreescribe o crea)
app.post('/api/trafico', async (req, res) => {
  try {
    const newTasks = req.body;
    
    if (!Array.isArray(newTasks)) {
      return res.status(400).json({ error: 'Formato incorrecto. Se esperaba un array de tareas.' });
    }

    // Actualizamos el documento existente (upsert = true creará si no existe)
    await Trafico.findOneAndUpdate(
      { docId: 'main' },
      { tasks: newTasks, lastUpdated: Date.now() },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, message: 'Datos guardados correctamente en MongoDB Atlas' });
  } catch (error) {
    console.error('Error guardando el tráfico:', error);
    res.status(500).json({ error: 'Error del servidor al guardar datos' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend ejecutándose en http://localhost:${PORT}`);
});
