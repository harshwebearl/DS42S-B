const mongoose = require('mongoose');
const Director = require('../models/Director');
const Village = require('../models/Village');
const Member = require('../models/Member');
const Nominee = require('../models/Nominee');
const FinancialYear = require('../models/FinancialYear');
const InstallmentMaster = require('../models/InstallmentMaster');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const PenaltyMaster = require('../models/PenaltyMaster');
const ClaimEligibilityPolicy = require('../models/ClaimEligibilityPolicy');
const LedgerEntry = require('../models/LedgerEntry');
const { generateSequentialId } = require('../utils/idGenerator');

async function seedInitialData() {
  console.log('[Seed] Checking and seeding initial system records...');

  // 1. Single Authorized Director Account
  let director = await Director.findOne({ email: 'director@ds24g.org' });
  if (!director) {
    const passwordHash = await Director.hashPassword('Director@2026');
    director = await Director.create({
      name: 'Director (Shree Dashashremali 42 Gnati Suraksha Samiti)',
      email: 'director@ds24g.org',
      passwordHash,
      phone: '+91 98765 43210',
      isActive: true
    });
    console.log('[Seed] Created Director account: director@ds24g.org / Director@2026');
  }

  // 2. Initial Villages of 42 Gnati
  const villageNames = [
    { name: 'Mahuva', taluka: 'Mahuva' },
    { name: 'Talaja', taluka: 'Talaja' },
    { name: 'Palitana', taluka: 'Palitana' },
    { name: 'Shihor', taluka: 'Shihor' },
    { name: 'Bhavnagar City', taluka: 'Bhavnagar' },
    { name: 'Vallabhipur', taluka: 'Vallabhipur' },
    { name: 'Gadhada', taluka: 'Gadhada' },
    { name: 'Savarkundla', taluka: 'Savarkundla' }
  ];

  const villageMap = {};
  for (let i = 0; i < villageNames.length; i++) {
    const v = villageNames[i];
    let found = await Village.findOne({ name: v.name });
    if (!found) {
      const villageId = `VIL-${String(i + 1).padStart(3, '0')}`;
      found = await Village.create({
        villageId,
        name: v.name,
        taluka: v.taluka,
        district: 'Bhavnagar',
        state: 'Gujarat',
        status: 'ACTIVE'
      });
      console.log(`[Seed] Created Village: ${found.villageId} - ${found.name}`);
    }
    villageMap[v.name] = found;
  }

  // 3. Financial Year Master (Year 2026)
  let fy2026 = await FinancialYear.findOne({ yearName: '2026' });
  if (!fy2026) {
    fy2026 = await FinancialYear.create({
      fyCode: 'FY-2026',
      yearName: '2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      isCurrent: true,
      status: 'ACTIVE',
      description: 'Samiti Financial Year 2026'
    });
    console.log('[Seed] Created Financial Year: 2026');
  }

  // 4. Dynamic Installment Master for Year 2026
  // Year 2026 Example from Prompt:
  // Installment 1: ₹1,000 (100000 paise)
  // Installment 2: ₹1,000 (100000 paise)
  // Installment 3: ₹1,000 (100000 paise)
  const initialInstallments = [
    { title: 'Installment 1', num: 1, amountPaise: 100000, due: '2026-03-31' },
    { title: 'Installment 2', num: 2, amountPaise: 100000, due: '2026-06-30' },
    { title: 'Installment 3', num: 3, amountPaise: 100000, due: '2026-09-30' }
  ];

  const instDocs = [];
  for (const inst of initialInstallments) {
    let doc = await InstallmentMaster.findOne({ financialYearId: fy2026._id, installmentNumber: inst.num });
    if (!doc) {
      doc = await InstallmentMaster.create({
        installmentId: `INST-2026-0${inst.num}`,
        financialYearId: fy2026._id,
        installmentTitle: inst.title,
        installmentNumber: inst.num,
        amountPaise: inst.amountPaise,
        startDate: new Date('2026-01-01'),
        dueDate: new Date(inst.due),
        status: 'ACTIVE',
        applicabilityRule: 'ALL_ACTIVE'
      });
      console.log(`[Seed] Created Installment: ${doc.installmentTitle} (₹1,000)`);
    }
    instDocs.push(doc);
  }

  // 5. Penalty Masters
  let penLate = await PenaltyMaster.findOne({ title: 'Late Payment Penalty' });
  if (!penLate) {
    penLate = await PenaltyMaster.create({
      penaltyId: 'PEN-001',
      title: 'Late Payment Penalty',
      type: 'FIXED',
      rateOrAmount: 10000, // ₹100
      gracePeriodDays: 15,
      applicableRule: 'AFTER_DUE_DATE',
      description: 'Flat ₹100 penalty for payment delayed past grace period',
      status: 'ACTIVE'
    });
  }

  let penBounce = await PenaltyMaster.findOne({ title: 'Cheque Bounce Penalty' });
  if (!penBounce) {
    penBounce = await PenaltyMaster.create({
      penaltyId: 'PEN-002',
      title: 'Cheque Bounce Penalty',
      type: 'FIXED',
      rateOrAmount: 50000, // ₹500
      applicableRule: 'BOUNCED_CHEQUE',
      description: 'Standard ₹500 fee charged when cheque bounces',
      status: 'ACTIVE'
    });
  }

  // 6. Claim Eligibility Policy
  let claimPolicy = await ClaimEligibilityPolicy.findOne({ status: 'ACTIVE' });
  if (!claimPolicy) {
    claimPolicy = await ClaimEligibilityPolicy.create({
      policyCode: 'POL-2026-V1',
      policyTitle: 'Shree Dashashremali Death Assistance Policy 2026',
      effectiveDate: new Date('2026-01-01'),
      minMembershipMonths: 0,
      pendingInstallmentRule: 'STRICT_ZERO_DUES',
      penaltyEligibilityRule: 'NO_UNPAID_PENALTIES',
      claimAmountType: 'FIXED',
      defaultClaimAmountPaise: 10000000, // ₹1,00,000
      requiredDocuments: [
        'Original Death Certificate issued by Municipal / Gram Panchayat',
        'Deceased Member ID Card & Aadhaar Copy',
        'Nominee KYC (Aadhaar & PAN Card)',
        'Nominee Bank Cancelled Cheque / Passbook Copy'
      ],
      status: 'ACTIVE'
    });
    console.log('[Seed] Created Claim Policy: ₹1,00,000 assistance with Strict Dues requirement');
  }

  // 7. Initial Sample Members (Family Heads) across villages
  const sampleMembers = [
    { id: 'SDS-001', name: 'Rameshchandra Mohanlal Shah', mobile: '9825012345', village: 'Mahuva', dob: '1970-05-15', occ: 'Business', nominee: 'Kokilaben R. Shah', rel: 'SPOUSE' },
    { id: 'SDS-002', name: 'Pravinbhai Keshubhai Mehta', mobile: '9825023456', village: 'Talaja', dob: '1975-08-20', occ: 'Trading', nominee: 'Bhavesh P. Mehta', rel: 'SON' },
    { id: 'SDS-003', name: 'Dineshbhai Kantilal Doshi', mobile: '9825034567', village: 'Palitana', dob: '1968-11-10', occ: 'Agriculture', nominee: 'Meenaben D. Doshi', rel: 'SPOUSE' },
    { id: 'SDS-004', name: 'Jayantilal Chhaganlal Vora', mobile: '9825045678', village: 'Shihor', dob: '1980-02-25', occ: 'Professional', nominee: 'Pooja J. Vora', rel: 'DAUGHTER' },
    { id: 'SDS-005', name: 'Chandrakant Popatlal Parekh', mobile: '9825056789', village: 'Bhavnagar City', dob: '1965-09-05', occ: 'Retired', nominee: 'Hiren C. Parekh', rel: 'SON' }
  ];

  for (const m of sampleMembers) {
    let member = await Member.findOne({ memberId: m.id });
    if (!member) {
      const vDoc = villageMap[m.village] || villageMap['Mahuva'];
      member = await Member.create({
        memberId: m.id,
        fullName: m.name,
        mobileNumber: m.mobile,
        email: `${m.name.split(' ')[0].toLowerCase()}@example.com`,
        villageId: vDoc._id,
        dob: new Date(m.dob),
        joiningDate: new Date('2025-01-01'),
        occupation: m.occ,
        gender: 'MALE',
        maritalStatus: true,
        address: `Main Bazar, ${m.village}, Dist. Bhavnagar`,
        panCard: 'ABCDE1234F',
        aadhaarCard: '987654321234',
        status: 'ACTIVE'
      });

      // Nominee
      const nomId = `NOM-${m.id.replace('SDS-', '')}`;
      const existingNom = await Nominee.findOne({ nomineeId: nomId });
      if (!existingNom) {
        await Nominee.create({
          nomineeId: nomId,
          memberId: member._id,
          nomineeName: m.nominee,
          relation: m.rel,
          sharePercentage: 100,
          priority: 1,
          status: 'ACTIVE'
        });
      }

      // Generate Installment Dues for this member for the 3 installments
      for (const inst of instDocs) {
        const dueId = `DUE-2026-${m.id.replace('SDS-', '')}-0${inst.installmentNumber}`;
        const existingDue = await MemberInstallmentDue.findOne({
          $or: [
            { memberId: member._id, installmentId: inst._id },
            { dueId }
          ]
        });
        if (!existingDue) {
          const due = await MemberInstallmentDue.create({
            dueId,
            memberId: member._id,
            installmentId: inst._id,
            financialYearId: fy2026._id,
            originalAmountPaise: inst.amountPaise,
            paidAmountPaise: 0,
            outstandingAmountPaise: inst.amountPaise,
            status: 'PENDING',
            dueDate: inst.dueDate
          });

          // Ledger Debit entry
          const ledgerId = `LED-2026-${m.id.replace('SDS-', '')}-0${inst.installmentNumber}`;
          const lastEntry = await LedgerEntry.findOne({ memberId: member._id }).sort({ transactionDate: -1, createdAt: -1 });
          const prevBal = lastEntry ? lastEntry.runningBalancePaise : 0;
          await LedgerEntry.create({
            ledgerId,
            memberId: member._id,
            transactionDate: inst.startDate || new Date(),
            entryType: 'INSTALLMENT_DUE',
            referenceId: due.dueId,
            description: `Installment Due: ${inst.installmentTitle} (2026)`,
            debitPaise: inst.amountPaise,
            creditPaise: 0,
            runningBalancePaise: prevBal + inst.amountPaise,
            status: 'POSTED',
            financialYearId: fy2026._id
          });
        }
      }

      console.log(`[Seed] Seeded Member ${member.memberId} (${member.fullName}) with dues.`);
    }
  }

  console.log('[Seed] Seeding completed successfully.');
}

module.exports = {
  seedInitialData
};
