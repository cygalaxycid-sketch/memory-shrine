// Entry point for the backend server
const express = require('express');
const mongoose = require('mongoose');
const userRoutes = require('./routes/userRoutes');
const memoryRoutes = require('./routes/memoryRoutes');

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use('/api/users', userRoutes);
app.use('/api/memories', memoryRoutes);

// Database connection
mongoose.connect(process.env.DB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port: ${PORT}`);
});
