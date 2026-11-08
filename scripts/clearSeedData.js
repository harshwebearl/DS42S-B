const mongoose = require('mongoose');
const dns = require('dns');
require('dotenv').config();

// Fix DNS for Windows if needed
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {}

const Member = require('../src/models/Member');
const Nominee = require('../src/models/Nominee');
const MemberInstallmentDue = require('../src/models/MemberInstallmentDue');
const MemberPenalty = require('../src/models/MemberPenalty');
const PaymentTransaction = require('../src/models/PaymentTransaction');
const PaymentAllocation = require('../src/models/PaymentAllocation');
const PaymentApplication = require('../src/models/PaymentApplication');
const LedgerEntry = require('../src/models/LedgerEntry');
const DeathClaim = require('../src/models/DeathClaim');
const ClaimCheque = require('../src/models/ClaimCheque');
const AuditLog = require('../src/models/AuditLog');
const Village = require('../src/models/Village');

async function clearData() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not defined in .env');
    process.exit(1);
  }

  console.log('[Clean] Connecting to MongoDB Atlas...');
  await mongoose.connect(uri);
  console.log('[Clean] Connected successfully.');

  console.log('[Clean] Deleting all dummy/sample members and transactional records...');

  const deletedMembers = await Member.deleteMany({});
  console.log(`✓ Deleted ${deletedMembers.deletedCount} members`);

  const deletedNominees = await Nominee.deleteMany({});
  console.log(`✓ Deleted ${deletedNominees.deletedCount} nominees`);

  const deletedDues = await MemberInstallmentDue.deleteMany({});
  console.log(`✓ Deleted ${deletedDues.deletedCount} member installment dues`);

  const deletedPenalties = await MemberPenalty.deleteMany({});
  console.log(`✓ Deleted ${deletedPenalties.deletedCount} member penalties`);

  const deletedTxns = await PaymentTransaction.deleteMany({});
  console.log(`✓ Deleted ${deletedTxns.deletedCount} payment transactions`);

  const deletedAlloc = await PaymentAllocation.deleteMany({});
  console.log(`✓ Deleted ${deletedAlloc.deletedCount} payment allocations`);

  const deletedApps = await PaymentApplication.deleteMany({});
  console.log(`✓ Deleted ${deletedApps.deletedCount} payment applications`);

  const deletedLedger = await LedgerEntry.deleteMany({});
  console.log(`✓ Deleted ${deletedLedger.deletedCount} ledger entries`);

  const deletedClaims = await DeathClaim.deleteMany({});
  console.log(`✓ Deleted ${deletedClaims.deletedCount} death claims`);

  const deletedCheques = await ClaimCheque.deleteMany({});
  console.log(`✓ Deleted ${deletedCheques.deletedCount} claim cheques`);

  const deletedAudit = await AuditLog.deleteMany({});
  console.log(`✓ Deleted ${deletedAudit.deletedCount} audit logs`);

  // Also remove test villages like 'VIL-011' Sihor Test Village created by tests
  const deletedTestVillages = await Village.deleteMany({ name: { $regex: /Test/i } });
  if (deletedTestVillages.deletedCount > 0) {
    console.log(`✓ Deleted ${deletedTestVillages.deletedCount} test villages`);
  }

  console.log('========================================================');
  console.log('ALL SEED / DUMMY DATA HAS BEEN COMPLETELY PURGED!');
  console.log('The CRM database is now 100% clean and ready for real data.');
  console.log('========================================================');

  await mongoose.disconnect();
  process.exit(0);
}

clearData().catch((err) => {
  console.error('Error clearing data:', err);
  process.exit(1);
});
