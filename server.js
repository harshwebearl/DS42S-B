const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { connectDB } = require('./src/config/db');
const { seedInitialData } = require('./src/seed/seedData');
const errorHandler = require('./src/middleware/errorHandler');

// Route imports
const authRoutes = require('./src/routes/authRoutes');
const villageRoutes = require('./src/routes/villageRoutes');
const memberRoutes = require('./src/routes/memberRoutes');
const nomineeRoutes = require('./src/routes/nomineeRoutes');
const financialYearRoutes = require('./src/routes/financialYearRoutes');
const installmentRoutes = require('./src/routes/installmentRoutes');
const penaltyRoutes = require('./src/routes/penaltyRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const chequeRoutes = require('./src/routes/chequeRoutes');
const reallocationRoutes = require('./src/routes/reallocationRoutes');
const ledgerRoutes = require('./src/routes/ledgerRoutes');
const deathClaimRoutes = require('./src/routes/deathClaimRoutes');
const claimPolicyRoutes = require('./src/routes/claimPolicyRoutes');
const claimChequeRoutes = require('./src/routes/claimChequeRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const auditRoutes = require('./src/routes/auditRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Security and utility middlewares
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    application: 'Shree Dashashremali 42 Gnati Suraksha Samiti CRM API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/villages', villageRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/nominees', nomineeRoutes);
app.use('/api/financial-years', financialYearRoutes);
app.use('/api/installments', installmentRoutes);
app.use('/api/penalties', penaltyRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/cheques', chequeRoutes);
app.use('/api/reallocations', reallocationRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/death-claims', deathClaimRoutes);
app.use('/api/claim-policies', claimPolicyRoutes);
app.use('/api/claim-cheques', claimChequeRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/audit-logs', auditRoutes);

// Serve frontend static build in production with explicit MIME types
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=UTF-8');
      } else if (filePath.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      } else if (filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      }
    }
  }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      return res.sendFile(path.join(frontendDist, 'index.html'));
    }
    next();
  });
}

// Centralized error handler
app.use(errorHandler);

// Server startup
async function startServer() {
  try {
    await connectDB();
    await seedInitialData();

    const server = app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`Shree Dashashremali 42 Gnati Suraksha Samiti CRM Server`);
      console.log(`Listening on http://localhost:${PORT}`);
      console.log(`Director Login: director@ds24g.org / Director@2026`);
      console.log(`=======================================================`);
    });

    return { app, server };
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
