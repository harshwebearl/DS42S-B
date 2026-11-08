const mongoose = require('mongoose');
const dns = require('dns');
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server');

let replSetInstance = null;
let memoryServerInstance = null;

async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (uri) {
    try {
      // Ensure Google DNS resolver is used to prevent Windows SRV ECONNREFUSED issues on mongodb+srv://
      try {
        dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
      } catch (dnsErr) {
        console.warn('[DB] Could not set custom DNS servers:', dnsErr.message);
      }

      console.log(`[DB] Attempting to connect to MongoDB Atlas...`);
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
      });
      console.log('[DB] Connected successfully to MongoDB Atlas Cluster!');
      return mongoose.connection;
    } catch (err) {
      console.warn('[DB] MongoDB Atlas connection failed, falling back to embedded Replica Set:', err.message);
    }
  }

  // Fallback to MongoMemoryReplSet (supports full multi-document transactions)
  try {
    console.log('[DB] Starting embedded MongoMemoryReplSet with transaction support...');
    replSetInstance = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger'
      }
    });
    const replUri = replSetInstance.getUri();
    await mongoose.connect(replUri);
    console.log(`[DB] Connected to embedded MongoMemoryReplSet at: ${replUri}`);
    return mongoose.connection;
  } catch (err) {
    console.warn('[DB] Failed to start MongoMemoryReplSet, attempting single MongoMemoryServer:', err.message);
    memoryServerInstance = await MongoMemoryServer.create();
    const memUri = memoryServerInstance.getUri();
    await mongoose.connect(memUri);
    console.log(`[DB] Connected to embedded MongoMemoryServer at: ${memUri}`);
    return mongoose.connection;
  }
}

async function disconnectDB() {
  await mongoose.disconnect();
  if (replSetInstance) {
    await replSetInstance.stop();
  }
  if (memoryServerInstance) {
    await memoryServerInstance.stop();
  }
}

module.exports = {
  connectDB,
  disconnectDB
};
