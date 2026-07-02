const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb+srv://dvh1910:1910%40Hoang@cluster0.rrygach.mongodb.net/license_server?retryWrites=true&w=majority&appName=Cluster0';

const licenseSchema = new mongoose.Schema({
  key: String,
  userEmail: String,
  customerName: String,
  planType: String,
  priceAtPurchase: Number,
  paymentStatus: String,
  status: String,
  expiresAt: String,
  createdAt: Date
});

const LicenseModel = mongoose.model('License', licenseSchema);

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');
  const record = await LicenseModel.findOne({ key: 'STUDIO-C4C267FF-EDED2C0E-14A4F5DE' });
  console.log('Record details:', JSON.stringify(record, null, 2));
  await mongoose.disconnect();
}

run().catch(console.error);
