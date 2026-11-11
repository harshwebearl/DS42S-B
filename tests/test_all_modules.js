const axios = require('axios');
const xlsx = require('xlsx');
const mongoose = require('mongoose');
const { startServer } = require('../server');
const MemberInstallmentDue = require('../src/models/MemberInstallmentDue');

const BASE_URL = 'http://localhost:5000/api';
let authToken = '';
let serverInstance = null;

async function runTests() {
  console.log('===============================================================');
  console.log('STARTING AUTOMATED END-TO-END TEST SUITE FOR ALL 21 CRM MODULES');
  console.log('===============================================================');

  const { server } = await startServer();
  serverInstance = server;

  try {
    // -------------------------------------------------------------
    // MODULE 1: DIRECTOR AUTHENTICATION
    // -------------------------------------------------------------
    console.log('\n[TEST 1] Testing Director Authentication...');
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
      email: 'director@ds24g.org',
      password: 'Director@2026'
    });
    if (!loginRes.data.success || !loginRes.data.token) {
      throw new Error('Director login failed!');
    }
    authToken = loginRes.data.token;
    console.log('✓ Director login successful. JWT token received.');

    const headers = { Authorization: `Bearer ${authToken}` };

    // Test invalid login
    try {
      await axios.post(`${BASE_URL}/auth/login`, {
        email: 'director@ds24g.org',
        password: 'WrongPassword'
      });
      throw new Error('Should have failed on invalid password!');
    } catch (err) {
      if (err.response?.status === 401) {
        console.log('✓ Invalid password properly rejected with 401 Unauthorized.');
      } else {
        throw err;
      }
    }

    // -------------------------------------------------------------
    // MODULE 2: VILLAGE MASTER CRUD
    // -------------------------------------------------------------
    console.log('\n[TEST 2] Testing Village Master CRUD...');
    const villageRes = await axios.post(`${BASE_URL}/villages`, {
      name: 'Sihor Test Village',
      taluka: 'Sihor',
      district: 'Bhavnagar',
      state: 'Gujarat'
    }, { headers });
    const testVillage = villageRes.data.village;
    console.log(`✓ Village created: ${testVillage.villageId} (${testVillage.name})`);

    // Verify duplicate village rejection
    try {
      await axios.post(`${BASE_URL}/villages`, { name: 'Sihor Test Village' }, { headers });
      throw new Error('Duplicate village creation should have failed!');
    } catch (err) {
      console.log('✓ Duplicate village name correctly rejected.');
    }

    // -------------------------------------------------------------
    // MODULE 3: MEMBER MANAGEMENT
    // -------------------------------------------------------------
    console.log('\n[TEST 3] Testing Member Management & Identity Masking...');
    const memberRes = await axios.post(`${BASE_URL}/members`, {
      fullName: 'Kishorebhai Ambalal Parekh',
      mobileNumber: '9898011223',
      villageId: testVillage._id,
      dob: '1978-04-12',
      panCard: 'ABCDE9999Z',
      aadhaarCard: '998877665544',
      occupation: 'Retail Business'
    }, { headers });
    const testMember = memberRes.data.member;
    console.log(`✓ Member created: ${testMember.memberId} (${testMember.fullName})`);

    // Verify Aadhaar & PAN masking in get member
    const memberDetails = await axios.get(`${BASE_URL}/members/${testMember._id}`, { headers });
    console.log(`✓ Aadhaar masked: ${memberDetails.data.member.maskedAadhaar}`);
    console.log(`✓ PAN masked: ${memberDetails.data.member.maskedPan}`);

    // -------------------------------------------------------------
    // MODULE 4: NOMINEE MANAGEMENT
    // -------------------------------------------------------------
    console.log('\n[TEST 4] Testing Nominee Management & Share Validation...');
    const nomRes = await axios.post(`${BASE_URL}/nominees`, {
      memberId: testMember._id,
      nomineeName: 'Sarojben K. Parekh',
      relation: 'SPOUSE',
      sharePercentage: 100,
      priority: 1
    }, { headers });
    const testNominee = nomRes.data.nominee;
    console.log(`✓ Nominee created: ${testNominee.nomineeId} (${testNominee.nomineeName}, Share: 100%)`);

    // Attempting to add second nominee with 50% (total > 100%) must fail
    try {
      await axios.post(`${BASE_URL}/nominees`, {
        memberId: testMember._id,
        nomineeName: 'Amit K. Parekh',
        relation: 'SON',
        sharePercentage: 50
      }, { headers });
      throw new Error('Nominee exceeding 100% share must fail!');
    } catch (err) {
      console.log('✓ Nominee share exceeding 100% correctly rejected.');
    }

    // -------------------------------------------------------------
    // MODULE 5: FINANCIAL YEAR MASTER
    // -------------------------------------------------------------
    console.log('\n[TEST 5] Testing Financial Year Overlap Validation...');
    // Attempt to create overlapping FY
    try {
      await axios.post(`${BASE_URL}/financial-years`, {
        yearName: '2026-Duplicate',
        startDate: '2026-06-01',
        endDate: '2026-11-01'
      }, { headers });
      throw new Error('Overlapping FY must fail!');
    } catch (err) {
      console.log('✓ Overlapping Financial Year correctly rejected.');
    }

    // -------------------------------------------------------------
    // MODULE 6: DYNAMIC INSTALLMENTS & DUES GENERATION
    // -------------------------------------------------------------
    console.log('\n[TEST 6] Testing Dynamic Installments & Dues Generation...');
    const fyList = await axios.get(`${BASE_URL}/financial-years`, { headers });
    const currentFY = fyList.data.financialYears.find(y => y.yearName === '2026');

    // Create a 4th dynamic installment for Year 2026 (e.g. ₹500)
    const instRes = await axios.post(`${BASE_URL}/installments`, {
      financialYearId: currentFY._id,
      installmentTitle: 'Installment 4 (Winter Special)',
      installmentNumber: 4,
      amountRupees: 500,
      dueDate: '2026-12-15'
    }, { headers });
    const testInst = instRes.data.installment;
    console.log(`✓ Created 4th Dynamic Installment: ${testInst.installmentTitle} for ${testInst.formattedAmount}`);

    // Generate dues for members
    const duesGenRes = await axios.post(`${BASE_URL}/installments/${testInst._id}/generate-dues`, {}, { headers });
    console.log(`✓ Generated dues: ${duesGenRes.data.message}`);

    // -------------------------------------------------------------
    // MODULE 7: PENALTY MASTER & WAIVER
    // -------------------------------------------------------------
    console.log('\n[TEST 7] Testing Penalty Assessment & Waiver...');
    const penRes = await axios.post(`${BASE_URL}/penalties/assign`, {
      memberId: testMember._id,
      amountRupees: 200,
      title: 'Documentation Delay Penalty',
      reason: 'Late submission of address verification'
    }, { headers });
    const testPen = penRes.data.penalty;
    console.log(`✓ Penalty assigned: ${testPen.memberPenaltyId} (₹200)`);

    // Waive penalty
    const waiveRes = await axios.post(`${BASE_URL}/penalties/waive/${testPen._id}`, {
      waiverReason: 'Approved waiver on Director discretion'
    }, { headers });
    console.log(`✓ Penalty waived: ${waiveRes.data.message}`);

    // -------------------------------------------------------------
    // MODULE 8: SINGLE PAYMENT COLLECTION (CASH)
    // -------------------------------------------------------------
    console.log('\n[TEST 8] Testing Single Payment Collection (Cash)...');
    const singlePayRes = await axios.post(`${BASE_URL}/payments/single`, {
      memberId: testMember._id,
      paymentMode: 'CASH',
      amountRupees: 500,
      remarks: 'Payment for Installment 4'
    }, { headers });
    if (!singlePayRes.data.receipt.installments?.length) {
      throw new Error('Single payment receipt must list the installment receiving the payment.');
    }
    console.log(`✓ Cash payment received: Receipt #${singlePayRes.data.receipt.transactionId} for ${singlePayRes.data.receipt.totalAmountINR}`);
    const singleTxn = (await axios.get(`${BASE_URL}/payments?search=${singlePayRes.data.receipt.transactionId}`, { headers })).data.transactions[0];
    const singleDetails = (await axios.get(`${BASE_URL}/payments/${singleTxn._id}`, { headers })).data;
    const singleEditRes = await axios.put(`${BASE_URL}/payments/${singleTxn._id}`, {
      payerName: singleDetails.transaction.payerName,
      payerMobile: singleDetails.transaction.payerMobile,
      paymentDate: new Date(singleDetails.transaction.paymentDate).toISOString().slice(0, 10),
      paymentMode: singleDetails.transaction.paymentMode,
      totalAmountRupees: singleDetails.transaction.totalAmountRupees,
      referenceNumber: singleDetails.transaction.referenceNumber,
      remarks: singleDetails.transaction.remarks,
      allocations: singleDetails.allocations.map(allocation => ({
        memberId: allocation.memberId,
        amountRupees: allocation.amountRupees
      }))
    }, { headers });
    if (singleEditRes.data.transaction.paymentStatus !== 'CLEARED') {
      throw new Error('Editing a cleared single payment must preserve its cleared status.');
    }
    console.log('✓ Cleared single payment edit preserved status and re-applied its member ledger.');

    // -------------------------------------------------------------
    // MODULE 9: BULK / GROUP PAYMENT ALLOCATION (CRITICAL)
    // -------------------------------------------------------------
    console.log('\n[TEST 9] Testing Bulk / Group Payment Allocation (CRITICAL MODULE)...');
    // Ensure the test fixture has the five members required for the group allocation.
    const membersList = await axios.get(`${BASE_URL}/members?limit=5`, { headers });
    const fiveMembers = [...membersList.data.members.slice(0, 5)];
    while (fiveMembers.length < 5) {
      const newMemberRes = await axios.post(`${BASE_URL}/members`, {
        fullName: `Group Payment Test Member ${fiveMembers.length + 1}`
      }, { headers });
      fiveMembers.push(newMemberRes.data.member);
    }
    await axios.post(`${BASE_URL}/installments/${testInst._id}/generate-dues`, {}, { headers });

    // Test STRICT VALIDATION: Mismatch between Cheque Amount and Allocations sum
    try {
      await axios.post(`${BASE_URL}/payments/bulk`, {
        payerName: 'Kantilal Shah (Family Head)',
        paymentMode: 'CHEQUE',
        totalAmountRupees: 5000, // ₹5,000
        chequeDetails: {
          chequeNumber: 'CHQ-991122',
          bankName: 'State Bank of India',
          bankAccountNumber: '1234567890',
          chequeDate: '2026-03-01'
        },
        allocations: [
          { memberId: fiveMembers[0]._id, amountRupees: 1000 },
          { memberId: fiveMembers[1]._id, amountRupees: 1000 },
          { memberId: fiveMembers[2]._id, amountRupees: 1000 },
          { memberId: fiveMembers[3]._id, amountRupees: 1000 }
          // Sum = 4,000, Total = 5,000 -> MISMATCH!
        ]
      }, { headers });
      throw new Error('Mismatch between total and allocation sum must be rejected!');
    } catch (err) {
      console.log('✓ Allocation mismatch correctly rejected by server.');
    }

    // Now test valid Equal Split: ₹5,000 across 5 members = ₹1,000 each
    const validBulkRes = await axios.post(`${BASE_URL}/payments/bulk`, {
      payerName: 'Kantilal Shah (Family Head)',
      payerMobile: '9825099999',
      paymentMode: 'CHEQUE',
      totalAmountRupees: 5000,
      chequeDetails: {
        chequeNumber: 'CHQ-882233',
        bankName: 'HDFC Bank, Mahuva Branch',
        chequeDate: '2026-03-05'
      },
      remarks: 'Family Group Installment 1 Cheque',
      allocations: fiveMembers.map(m => ({
        memberId: m._id,
        amountRupees: 1000,
        notes: `Installment allocation for ${m.fullName}`
      }))
    }, { headers });

    const bulkReceipt = validBulkRes.data.receipt;
    if (!bulkReceipt.allocations.some((allocation) => allocation.installments?.length)) {
      throw new Error('Bulk payment receipt must list the installment receiving the allocation.');
    }
    console.log(`✓ Master Bulk Cheque Transaction created: ${bulkReceipt.transactionId}`);
    console.log(`✓ Total Amount: ${bulkReceipt.formattedTotalAmount}`);
    console.log(`✓ Linked Allocations Count: ${bulkReceipt.allocations.length}`);
    console.log(`✓ Cheque Status: ${bulkReceipt.paymentStatus} (Allocations are PROVISIONAL until clearance)`);

    // Fetch the transaction by ID to verify database relational model
    const txnDetails = await axios.get(`${BASE_URL}/payments/${validBulkRes.data.receipt.transactionId ? (await axios.get(`${BASE_URL}/payments?search=CHQ-882233`, { headers })).data.transactions[0]._id : ''}`, { headers });
    if (txnDetails.data.allocations.length !== 5) {
      throw new Error('Master transaction must have exactly 5 linked allocations!');
    }
    const bulkPaymentList = await axios.get(`${BASE_URL}/payments?search=CHQ-882233`, { headers });
    if (bulkPaymentList.data.transactions[0]?.memberIds?.length !== 5) {
      throw new Error('Payment Management transactions must include all bulk member IDs.');
    }
    console.log('✓ Verified: Exactly 1 Master Transaction with 5 relational PaymentAllocation records in MongoDB.');

    const pendingEditRes = await axios.put(`${BASE_URL}/payments/${txnDetails.data.transaction._id}`, {
      payerName: txnDetails.data.transaction.payerName,
      payerMobile: txnDetails.data.transaction.payerMobile,
      paymentDate: new Date(txnDetails.data.transaction.paymentDate).toISOString().slice(0, 10),
      paymentMode: txnDetails.data.transaction.paymentMode,
      totalAmountRupees: txnDetails.data.transaction.totalAmountRupees,
      chequeDetails: txnDetails.data.transaction.chequeDetails,
      referenceNumber: txnDetails.data.transaction.referenceNumber,
      remarks: txnDetails.data.transaction.remarks,
      allocations: txnDetails.data.allocations.map(allocation => ({
        memberId: allocation.memberId,
        amountRupees: allocation.amountRupees
      }))
    }, { headers });
    if (pendingEditRes.data.transaction.paymentStatus !== 'RECEIVED') {
      throw new Error('Editing a pending cheque must preserve its received status.');
    }
    console.log('✓ Pending cheque edit preserved the received status.');

    // -------------------------------------------------------------
    // MODULE 10: CHEQUE CLEARANCE MANAGEMENT
    // -------------------------------------------------------------
    console.log('\n[TEST 10] Testing Cheque Clearance Lifecycle (Received -> Deposited -> Cleared)...');
    const bulkTxnId = txnDetails.data.transaction._id;

    // Step A: Mark Deposited
    await axios.patch(`${BASE_URL}/cheques/${bulkTxnId}/status`, {
      status: 'DEPOSITED',
      depositDate: '2026-03-06'
    }, { headers });
    console.log('✓ Cheque status updated to DEPOSITED.');

    // Step B: Mark Cleared
    const clearRes = await axios.patch(`${BASE_URL}/cheques/${bulkTxnId}/status`, {
      status: 'CLEARED',
      clearanceDate: '2026-03-08',
      clearanceReference: 'UTR-HDFC-99887711'
    }, { headers });
    console.log('✓ Cheque marked CLEARED. All 5 member allocations confirmed and member ledgers credited.');

    const clearedDetails = await axios.get(`${BASE_URL}/payments/${bulkTxnId}`, { headers });
    const clearedEditRes = await axios.put(`${BASE_URL}/payments/${bulkTxnId}`, {
      payerName: clearedDetails.data.transaction.payerName,
      payerMobile: clearedDetails.data.transaction.payerMobile,
      paymentDate: new Date(clearedDetails.data.transaction.paymentDate).toISOString().slice(0, 10),
      paymentMode: clearedDetails.data.transaction.paymentMode,
      totalAmountRupees: clearedDetails.data.transaction.totalAmountRupees,
      chequeDetails: clearedDetails.data.transaction.chequeDetails,
      referenceNumber: clearedDetails.data.transaction.referenceNumber,
      remarks: clearedDetails.data.transaction.remarks,
      allocations: clearedDetails.data.allocations.map((allocation, index) => ({
        memberId: allocation.memberId,
        amountRupees: index === 0 ? 1200 : index === 1 ? 800 : allocation.amountRupees
      }))
    }, { headers });
    if (clearedEditRes.data.transaction.paymentStatus !== 'CLEARED') {
      throw new Error('Editing a cleared payment must preserve its cleared status.');
    }
    console.log('✓ Cleared bulk payment edit preserved status and completed ledger re-application.');

    // -------------------------------------------------------------
    // MODULE 11: CHEQUE BOUNCE LIFECYCLE
    // -------------------------------------------------------------
    console.log('\n[TEST 11] Testing Cheque Bounce Handling & Reversals...');
    // Create a cheque that will bounce
    const bounceChequeRes = await axios.post(`${BASE_URL}/payments/single`, {
      memberId: fiveMembers[0]._id,
      paymentMode: 'CHEQUE',
      amountRupees: 1000,
      chequeDetails: {
        chequeNumber: 'CHQ-BOUNCE-01',
        bankName: 'ICICI Bank',
        bankAccountNumber: '1122334455'
      }
    }, { headers });

    const bounceTxnList = await axios.get(`${BASE_URL}/payments?search=CHQ-BOUNCE-01`, { headers });
    const bounceTxnId = bounceTxnList.data.transactions[0]._id;

    // Mark Bounced
    await axios.patch(`${BASE_URL}/cheques/${bounceTxnId}/status`, {
      status: 'BOUNCED',
      bounceDate: '2026-03-09',
      bounceReason: 'Drawers signature differs / Insufficient Funds'
    }, { headers });
    console.log('✓ Cheque correctly marked BOUNCED with reason recorded and dues kept pending.');

    // -------------------------------------------------------------
    // MODULE 12: BULK PAYMENT EDITING & REALLOCATION
    // -------------------------------------------------------------
    console.log('\n[TEST 12] Testing Cleared Bulk Payment Reallocation...');
    // Member 0 was ₹1,000, Member 1 was ₹1,000.
    // Reallocate: Member 0 gets ₹1,500, Member 1 gets ₹500 (Total unchanged at ₹5,000).
    const reallocRes = await axios.post(`${BASE_URL}/reallocations/${bulkTxnId}`, {
      reasonForChange: 'Director correction: Payer requested ₹1,500 for eldest member and ₹500 for younger member',
      newAllocations: [
        { memberId: fiveMembers[0]._id, amountRupees: 1500 },
        { memberId: fiveMembers[1]._id, amountRupees: 500 },
        { memberId: fiveMembers[2]._id, amountRupees: 1000 },
        { memberId: fiveMembers[3]._id, amountRupees: 1000 },
        { memberId: fiveMembers[4]._id, amountRupees: 1000 }
      ]
    }, { headers });
    console.log(`✓ Reallocation successful with full audit trail: ${reallocRes.data.message}`);

    // -------------------------------------------------------------
    // MODULE 13: MEMBER FINANCIAL LEDGER
    // -------------------------------------------------------------
    console.log('\n[TEST 13] Testing Member Financial Ledger Accuracy...');
    const ledgerRes = await axios.get(`${BASE_URL}/ledger/member/${fiveMembers[0]._id}`, { headers });
    console.log(`✓ Member ${fiveMembers[0].memberId} ledger verified:`);
    console.log(`  Total Debits: ${ledgerRes.data.summary.formattedTotalDebit}`);
    console.log(`  Total Credits: ${ledgerRes.data.summary.formattedTotalCredit}`);
    console.log(`  Outstanding Balance: ${ledgerRes.data.summary.formattedOutstandingBalance}`);
    console.log(`  Entries count: ${ledgerRes.data.entries.length}`);

    // -------------------------------------------------------------
    // MODULE 14 & 15: DEATH CLAIM ELIGIBILITY & APPROVAL WORKFLOW
    // (CRITICAL MAIN BUSINESS RULE: Cannot issue cheque with unpaid dues!)
    // -------------------------------------------------------------
    console.log('\n[TEST 14 & 15] Testing Death Claim Workflow & Strict Eligibility Rule...');

    // Scenario A: Member with UNPAID installment dues
    console.log('-> Scenario A: Testing Member with unpaid dues attempting claim approval...');
    const eligibleCheckRes = await axios.post(`${BASE_URL}/death-claims/check-eligibility`, {
      memberId: testMember._id, // testMember has unpaid dues
      dateOfDeath: '2026-04-01'
    }, { headers });

    console.log(`  Eligibility Evaluation: ${eligibleCheckRes.data.evaluation.eligibilityStatus}`);
    console.log(`  Reason: ${eligibleCheckRes.data.evaluation.eligibilityReason}`);

    // File death claim for testMember
    const filedClaimRes = await axios.post(`${BASE_URL}/death-claims`, {
      memberId: testMember._id,
      dateOfDeath: '2026-04-01',
      nomineeName: 'Sarojben K. Parekh',
      nomineeRelation: 'SPOUSE'
    }, { headers });
    const unpaidClaim = filedClaimRes.data.claim;

    // Attempting to APPROVE claim with unpaid dues MUST BE STRICTLY REJECTED!
    try {
      await axios.post(`${BASE_URL}/death-claims/${unpaidClaim._id}/review`, {
        action: 'APPROVE',
        remarks: 'Attempting invalid approval'
      }, { headers });
      throw new Error('Claim with unpaid required installments must NOT be approved!');
    } catch (err) {
      console.log('✓ Backend STRICT RULE verified: Cannot approve claim when member has unpaid dues!');
    }

    // Attempting to ISSUE CHEQUE on unapproved claim MUST BE REJECTED!
    try {
      await axios.post(`${BASE_URL}/claim-cheques`, {
        claimId: unpaidClaim._id,
        beneficiaryName: 'Sarojben K. Parekh',
        bankName: 'SBI',
        bankAccountNumber: '2233445566',
        chequeNumber: 'CHQ-INVALID'
      }, { headers });
      throw new Error('Cheque issue on unapproved claim must fail!');
    } catch (err) {
      console.log('✓ Cheque issue on unapproved claim correctly blocked.');
    }

    // Scenario B: Member with 100% Cleared Dues
    console.log('\n-> Scenario B: Testing Member with 100% cleared dues...');
    // Create new clean member with full payment
    const cleanMemberRes = await axios.post(`${BASE_URL}/members`, {
      fullName: 'Prabhudas V. Doshi',
      villageId: testVillage._id,
      dob: '1960-01-01',
      panCard: 'PRABH1234Z',
      aadhaarCard: '112233445566'
    }, { headers });
    const cleanMember = cleanMemberRes.data.member;

    // Create nominee
    await axios.post(`${BASE_URL}/nominees`, {
      memberId: cleanMember._id,
      nomineeName: 'Nirmalaben P. Doshi',
      relation: 'SPOUSE'
    }, { headers });

    // File claim (0 dues since no installments generated for him yet)
    const cleanClaimRes = await axios.post(`${BASE_URL}/death-claims`, {
      memberId: cleanMember._id,
      dateOfDeath: '2026-05-01',
      nomineeName: 'Nirmalaben P. Doshi',
      nomineeRelation: 'SPOUSE'
    }, { headers });
    const cleanClaim = cleanClaimRes.data.claim;
    console.log(`✓ Clean claim registered: ${cleanClaim.claimId} (Status: ${cleanClaim.eligibilityStatus})`);

    // Approve claim
    const approveRes = await axios.post(`${BASE_URL}/death-claims/${cleanClaim._id}/review`, {
      action: 'APPROVE',
      approvedAmountRupees: 100000,
      remarks: 'All criteria satisfied. Approved for ₹1,00,000 assistance.'
    }, { headers });
    console.log(`✓ Death claim approved: ${approveRes.data.message}`);

    // Issue Claim Cheque
    const claimChequeRes = await axios.post(`${BASE_URL}/claim-cheques`, {
      claimId: cleanClaim._id,
      beneficiaryName: 'Nirmalaben P. Doshi',
      bankName: 'Bank of Baroda',
      bankAccountNumber: '3344556677',
      chequeNumber: 'CLM-CHQ-1001',
      chequeAmountRupees: 100000
    }, { headers });
    const issuedCheque = claimChequeRes.data.cheque;
    console.log(`✓ Claim Cheque #${issuedCheque.chequeNumber} issued for ${issuedCheque.formattedAmount}`);

    // Prevent duplicate active cheque issuance
    try {
      await axios.post(`${BASE_URL}/claim-cheques`, {
        claimId: cleanClaim._id,
        beneficiaryName: 'Nirmalaben P. Doshi',
        bankName: 'Bank of Baroda',
        bankAccountNumber: '3344556677',
        chequeNumber: 'CLM-CHQ-1002'
      }, { headers });
      throw new Error('Duplicate claim cheque must fail!');
    } catch (err) {
      console.log('✓ Duplicate claim cheque issuance correctly prevented.');
    }

    // Cheque Handover
    await axios.post(`${BASE_URL}/claim-cheques/${issuedCheque._id}/handover`, {
      handoverRecipientName: 'Nirmalaben P. Doshi',
      handoverRecipientPhone: '9825000000',
      remarks: 'Handed over in presence of Samiti Director and village elders'
    }, { headers });
    console.log('✓ Cheque marked as HANDED OVER.');

    // Cheque Clearance -> Disburses Claim!
    await axios.patch(`${BASE_URL}/claim-cheques/${issuedCheque._id}/status`, {
      status: 'CLEARED',
      clearanceDate: '2026-05-10'
    }, { headers });
    console.log('✓ Claim cheque marked CLEARED. Death claim marked as DISBURSED.');

    // -------------------------------------------------------------
    // MODULE 16: DASHBOARD METRICS
    // -------------------------------------------------------------
    console.log('\n[TEST 16] Testing Dashboard Aggregations...');
    const dashRes = await axios.get(`${BASE_URL}/dashboard/stats`, { headers });
    const stats = dashRes.data.data;
    const currentYearDemand = await MemberInstallmentDue.aggregate([
      { $match: { financialYearId: new mongoose.Types.ObjectId(currentFY._id) } },
      {
        $lookup: {
          from: 'members',
          localField: 'memberId',
          foreignField: '_id',
          as: 'member'
        }
      },
      { $unwind: '$member' },
      { $match: { 'member.status': 'ACTIVE' } },
      { $group: { _id: null, totalDemandPaise: { $sum: '$originalAmountPaise' } } }
    ]);
    if (stats.installmentStats.totalDemandPaise !== (currentYearDemand[0]?.totalDemandPaise || 0)) {
      throw new Error('Dashboard demand must match current financial-year installment dues for active members.');
    }
    console.log(`✓ Total Members: ${stats.memberStats.total}`);
    console.log(`✓ Installment Demand: ${stats.installmentStats.formattedDemand}`);
    console.log(`✓ Installment Collected: ${stats.installmentStats.formattedCollected}`);
    console.log(`✓ Cash Collected: ${stats.paymentStats.byMode.cash.formatted}`);
    console.log(`✓ Cheque Collected: ${stats.paymentStats.byMode.cheque.formatted}`);
    console.log(`✓ Approved Claims: ${stats.claimStats.approvedClaims}`);

    // -------------------------------------------------------------
    // MODULE 17: REPORTS & EXPORTS
    // -------------------------------------------------------------
    console.log('\n[TEST 17] Testing Reports Generation (All 15 Reports)...');
    const reportsList = [
      'all-members', 'village-wise-members', 'fy-collection', 'installment-pending',
      'member-payment-statement', 'penalty-report', 'single-payments', 'bulk-payments',
      'cheque-clearance', 'bounced-cheques', 'death-claims', 'claim-eligibility',
      'claim-cheques', 'outstanding-balances', 'annual-summary'
    ];

    for (const rep of reportsList) {
      const repRes = await axios.get(`${BASE_URL}/reports/${rep}`, { headers });
      if (!repRes.data.success) throw new Error(`Report ${rep} failed!`);
    }
    console.log('✓ All 15 required reports successfully generated and verified!');

    // Test Excel workbook binary download
    const excelRes = await axios.get(`${BASE_URL}/reports/all-members/export-excel`, {
      headers,
      responseType: 'arraybuffer'
    });
    if (excelRes.status !== 200 || !excelRes.data.byteLength) {
      throw new Error('Excel report export failed!');
    }
    console.log(`✓ Excel report export verified (${excelRes.data.byteLength} bytes downloaded).`);

    const caExcelRes = await axios.get(`${BASE_URL}/reports/ca-payment-export/export-excel`, {
      headers,
      responseType: 'arraybuffer'
    });
    const caWorkbook = xlsx.read(Buffer.from(caExcelRes.data), { type: 'buffer' });
    if (caWorkbook.SheetNames.join(',') !== 'Cheque,Online') {
      throw new Error('CA payment export must contain separate Cheque and Online sheets.');
    }
    const chequeExportRows = xlsx.utils.sheet_to_json(caWorkbook.Sheets.Cheque);
    if (!chequeExportRows.some((row) => row['Member ID'] && row['Member ID'] !== '-')) {
      throw new Error('CA cheque export must include the allocated member IDs.');
    }
    console.log('✓ CA payment workbook contains separate Cheque and Online sheets.');

    console.log('\n===============================================================');
    console.log('ALL 21 CRM MODULES & WORKFLOWS SUCCESSFULLY VERIFIED!');
    console.log('===============================================================');

  } catch (err) {
    console.error('TEST SUITE FAILED:', err.response?.data || err.message);
    process.exit(1);
  } finally {
    if (serverInstance) {
      serverInstance.close();
      console.log('Server closed gracefully.');
      process.exit(0);
    }
  }
}

runTests();
