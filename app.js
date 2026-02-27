// app.js - FINAL VERSION (FIXED)
require('dotenv').config({
debug: false, quiet: true
});
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

// IMPORT RUTE API (PENTING)
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// ==========================================
// MIDDLEWARE (TAMBAHAN PENTING UNTUK BACA JSON DARI FLUTTER)
// ==========================================
app.use(express.json()); // Membaca tipe application/json
app.use(express.urlencoded({ extended: true })); // Membaca tipe application/x-www-form-urlencoded

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// PASTIKAN API ROUTE ADA DI BAWAH MIDDLEWARE EXPRESS.JSON
app.use('/api', apiRoutes);

// ==========================================
// SERVER STARTUP
// ==========================================

const DB_URI = process.env.DB_URI;

if (!DB_URI) {
console.error("FATAL ERROR: DB_URI is not defined in environment variables.");
process.exit(1);
}

const startServer = async () => {
try {
await mongoose.connect(DB_URI, {
serverSelectionTimeoutMS: 30000
});
console.log('Successfully connected to MongoDB...');

app.listen(PORT, () => {
console.log(`Server is running on port: ${PORT}`);
console.log(`Access at: ${WEBSITE_URL}`);
});

} catch (err) {
console.error('Failed to connect to MongoDB. Server will not start.', err);
process.exit(1);
}
};

startServer();
