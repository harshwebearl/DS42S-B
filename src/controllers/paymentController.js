const mongoose = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const PaymentApplication = require('../models/PaymentApplication');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const MemberPenalty = require('../models/MemberPenalty');
const Member = require('../models/Member');
const AuditLog = require('../models/AuditLog');
const PenaltyMaster = require('../models/PenaltyMaster');
const LedgerEntry = require('../models/LedgerEntry');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Helper to apply payment amount to member dues sequentially
async function applyPaymentToDues({ memberId, allocationId, amountToApplyPaise, isConfirmed, session, selectedDueIds, waivePenalty = false, waivedDueIds = [] }) {
  let remainingPaise = amountToApplyPaise;
  const applications = [];
  const waivedPenalties = [];

  const dueQuery = {
    memberId,
    status: { $in: ['PENDING', 'PARTIAL', 'OVERDUE'] }
  };
  if (selectedDueIds && Array.isArray(selectedDueIds) && selectedDueIds.length > 0) {
    dueQuery._id = { $in: selectedDueIds };
  }

  // 1. First apply to selected unpaid/partial installment dues (sorted by dueDate)
  const dues = await MemberInstallmentDue.find(dueQuery).sort({ dueDate: 1 }).session(session);

  const latePenaltyMaster = await PenaltyMaster.findOne({
    applicableRule: 'AFTER_DUE_DATE',
    status: 'ACTIVE'
  }).session(session);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const due of dues) {
    if (remainingPaise <= 0) break;

    const dueOutstanding = due.outstandingAmountPaise;
    const paymentForThisDue = Math.min(remainingPaise, dueOutstanding);

    if (paymentForThisDue > 0) {
      const appId = await generateSequentialId(PaymentApplication, 'applicationId', 'APP', 5);
      const app = await PaymentApplication.create([{
        applicationId: appId,
        allocationId,
        installmentDueId: due._id,
        appliedAmountPaise: paymentForThisDue,
        status: isConfirmed ? 'APPLIED' : 'PROVISIONAL'
      }], { session });

      applications.push(app[0]);

      if (isConfirmed) {
        due.paidAmountPaise += paymentForThisDue;
        due.outstandingAmountPaise -= paymentForThisDue;
        due.lastPaymentDate = new Date();
        due.status = due.outstandingAmountPaise === 0 ? 'PAID' : 'PARTIAL';
        await due.save({ session });
      }

      remainingPaise -= paymentForThisDue;
    }

    // Check if penalty for this specific due was waived by director
    const isDueWaived = Boolean(waivePenalty) || (Array.isArray(waivedDueIds) && waivedDueIds.some(id => String(id) === String(due._id)));

    // Check if 3 months have passed since due date:
    if (!isDueWaived && due.dueDate && latePenaltyMaster) {
      const dueDate = new Date(due.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      const threeMonthsDate = new Date(dueDate);
      threeMonthsDate.setMonth(threeMonthsDate.getMonth() + 3);
      threeMonthsDate.setHours(0, 0, 0, 0);

      if (today >= threeMonthsDate) {
        let penaltyPaise = latePenaltyMaster.type === 'FIXED'
          ? latePenaltyMaster.rateOrAmount
          : Math.round((due.originalAmountPaise * latePenaltyMaster.rateOrAmount) / 100);

        if (penaltyPaise > 0) {
          // Check if already created for this due
          const existingPen = await MemberPenalty.findOne({
            memberId,
            penaltyMasterId: latePenaltyMaster._id,
            reason: { $regex: due.dueId }
          }).session(session);

          if (!existingPen) {
            const memberPenaltyId = await generateSequentialId(MemberPenalty, 'memberPenaltyId', 'MPEN', 5);
            await MemberPenalty.create([{
              memberPenaltyId,
              memberId,
              penaltyMasterId: latePenaltyMaster._id,
              title: `${latePenaltyMaster.title} (3+ Months Overdue - ${due.dueId})`,
              amountPaise: penaltyPaise,
              paidAmountPaise: 0,
              waivedAmountPaise: 0,
              outstandingAmountPaise: penaltyPaise,
              status: 'PENDING',
              reason: `Auto-assessed: Installment due date was ${due.dueDate.toISOString().split('T')[0]}, exceeded 3 months [${due.dueId}]`
            }], { session });

            // Post debit to member ledger for this penalty
            if (isConfirmed) {
              const lastLedger = await LedgerEntry.findOne({ memberId }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
              const prevBal = lastLedger ? lastLedger.runningBalancePaise : 0;
              const ledId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
              await LedgerEntry.create([{
                ledgerId: ledId,
                memberId,
                transactionDate: new Date(),
                entryType: 'PENALTY',
                referenceId: memberPenaltyId,
                description: `Penalty Assessed: 3+ Months Overdue on ${due.dueId}`,
                debitPaise: penaltyPaise,
                creditPaise: 0,
                runningBalancePaise: prevBal + penaltyPaise,
                status: 'POSTED'
              }], { session });
            }
          }
        }
      }
    } else if (isDueWaived && due.dueDate) {
      // If director waived the penalty, mark any previously assessed pending penalty for this due as WAIVED
      const existingPen = await MemberPenalty.findOne({
        memberId,
        status: { $in: ['PENDING', 'PARTIAL'] },
        reason: { $regex: due.dueId }
      }).session(session);

      if (existingPen) {
        const amountPaise = existingPen.outstandingAmountPaise;
        existingPen.waivedAmountPaise += existingPen.outstandingAmountPaise;
        existingPen.outstandingAmountPaise = 0;
        existingPen.status = 'WAIVED';
        await existingPen.save({ session });
        waivedPenalties.push({ penaltyId: existingPen._id, amountPaise });
      }
    }
  }

  // 2. If remaining money exists and penalty is not waived, apply to outstanding penalties
  if (!waivePenalty && remainingPaise > 0) {
    const penalties = await MemberPenalty.find({
      memberId,
      status: { $in: ['PENDING', 'PARTIAL'] }
    }).sort({ createdAt: 1 }).session(session);

    for (const pen of penalties) {
      if (remainingPaise <= 0) break;

      const penOutstanding = pen.outstandingAmountPaise;
      const paymentForPen = Math.min(remainingPaise, penOutstanding);

      if (paymentForPen > 0) {
        const appId = await generateSequentialId(PaymentApplication, 'applicationId', 'APP', 5);
        const app = await PaymentApplication.create([{
          applicationId: appId,
          allocationId,
          memberPenaltyId: pen._id,
          appliedAmountPaise: paymentForPen,
          status: isConfirmed ? 'APPLIED' : 'PROVISIONAL'
        }], { session });

        applications.push(app[0]);

        if (isConfirmed) {
          pen.paidAmountPaise += paymentForPen;
          pen.outstandingAmountPaise -= paymentForPen;
          pen.status = pen.outstandingAmountPaise === 0 ? 'PAID' : 'PARTIAL';
          await pen.save({ session });
        }

        remainingPaise -= paymentForPen;
      }
    }
  }

  return { remainingPaise, applications, waivedPenalties };
}

// 1. Single Member Payment Collection
async function createSinglePayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      memberId,
      payerName,
      payerMobile,
      paymentDate,
      paymentMode,
      amountRupees,
      financialYearId,
      chequeDetails,
      referenceNumber,
      remarks,
      selectedDueIds,
      waivePenalty = false,
      waivedDueIds = []
    } = req.body;

    if (!memberId || !paymentMode || amountRupees === undefined) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Member ID, Payment Mode, and Amount are required.' });
    }

    const member = await Member.findById(memberId).populate('villageId').session(session);
    if (!member) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    const amountPaise = rupeesToPaise(amountRupees);
    if (amountPaise <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Payment amount must be greater than zero.' });
    }

    const isCheque = paymentMode === 'CHEQUE';
    const isConfirmed = !isCheque; // Cash, UPI, and Bank Transfer clear immediately

    if (isCheque) {
      if (!chequeDetails || !chequeDetails.chequeNumber || !chequeDetails.bankName || !chequeDetails.bankAccountNumber?.trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Cheque Number, Bank Name, and Bank Account Number are required for cheque payments.' });
      }
    }

    const transactionId = await generateSequentialId(PaymentTransaction, 'transactionId', 'TXN', 5);

    const transaction = (await PaymentTransaction.create([{
      transactionId,
      isBulk: false,
      singleMemberId: member._id,
      payerName: payerName ? payerName.trim() : member.fullName,
      payerMobile: payerMobile ? payerMobile.trim() : member.mobileNumber,
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      paymentMode,
      totalAmountPaise: amountPaise,
      financialYearId: financialYearId || undefined,
      chequeDetails: isCheque ? {
        chequeNumber: chequeDetails.chequeNumber.trim(),
        bankName: chequeDetails.bankName.trim(),
        bankAccountNumber: chequeDetails.bankAccountNumber.trim(),
        chequeDate: chequeDetails.chequeDate ? new Date(chequeDetails.chequeDate) : new Date()
      } : undefined,
      referenceNumber: referenceNumber ? referenceNumber.trim() : '',
      paymentStatus: isCheque ? 'RECEIVED' : 'CLEARED',
      remarks: remarks ? remarks.trim() : '',
      createdBy: req.director ? req.director._id : undefined
    }], { session }))[0];

    // Create 1 allocation for this single member
    const allocationId = await generateSequentialId(PaymentAllocation, 'allocationId', 'ALLOC', 5);
    const allocation = (await PaymentAllocation.create([{
      allocationId,
      transactionId: transaction._id,
      memberId: member._id,
      allocatedAmountPaise: amountPaise,
      status: isConfirmed ? 'CONFIRMED' : 'PROVISIONAL',
      selectedDueIds: Array.isArray(selectedDueIds) ? selectedDueIds : [],
      waivedDueIds: Array.isArray(waivedDueIds) ? waivedDueIds : [],
      waivePenalty: Boolean(waivePenalty),
      notes: `Single payment via ${paymentMode}`
    }], { session }))[0];

    // Apply payment to dues
    const applicationResult = await applyPaymentToDues({
      memberId: member._id,
      allocationId: allocation._id,
      amountToApplyPaise: amountPaise,
      isConfirmed,
      session,
      selectedDueIds,
      waivePenalty: Boolean(waivePenalty),
      waivedDueIds
    });
    allocation.waivedPenalties = applicationResult.waivedPenalties;
    await allocation.save({ session });

    // If confirmed immediately (cash/UPI/bank transfer), write Ledger Entry (Credit)
    if (isConfirmed) {
      const lastEntry = await LedgerEntry.findOne({ memberId: member._id }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
      const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
      const newBalancePaise = prevBalancePaise - amountPaise;

      const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
      await LedgerEntry.create([{
        ledgerId,
        memberId: member._id,
        transactionDate: transaction.paymentDate,
        entryType: 'PAYMENT',
        referenceId: transaction.transactionId,
        description: `Payment Received via ${paymentMode} (Ref: ${referenceNumber || transaction.transactionId})`,
        debitPaise: 0,
        creditPaise: amountPaise,
        runningBalancePaise: newBalancePaise,
        status: 'POSTED',
        financialYearId
      }], { session });
    }

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: 'SINGLE_PAYMENT_COLLECTED',
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        memberId: member.memberId,
        amountINR: amountRupees,
        paymentMode,
        status: transaction.paymentStatus
      }
    });

    res.status(201).json({
      success: true,
      message: isCheque
        ? 'Cheque payment recorded as RECEIVED. Awaiting clearance.'
        : 'Payment received and processed successfully.',
      receipt: {
        transactionId: transaction.transactionId,
        payerName: transaction.payerName,
        paymentDate: transaction.paymentDate,
        paymentMode: transaction.paymentMode,
        totalAmountPaise: transaction.totalAmountPaise,
        totalAmountINR: formatINR(transaction.totalAmountPaise),
        paymentStatus: transaction.paymentStatus,
        chequeDetails: transaction.chequeDetails,
        referenceNumber: transaction.referenceNumber,
        member: {
          memberId: member.memberId,
          fullName: member.fullName,
          village: member.villageId ? member.villageId.name : ''
        }
      }
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

// 2. Bulk / Group Payment Allocation (CRITICAL MODULE)
async function createBulkPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      payerName,
      payerMobile,
      paymentDate,
      paymentMode,
      totalAmountRupees,
      chequeDetails,
      referenceNumber,
      remarks,
      allocations // Array of { memberId, amountRupees, notes }
    } = req.body;

    if (!payerName || !paymentMode || totalAmountRupees === undefined || !Array.isArray(allocations) || allocations.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Payer Name, Payment Mode, Total Amount, and member allocations array are required.'
      });
    }

    const totalAmountPaise = rupeesToPaise(totalAmountRupees);
    if (totalAmountPaise <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Total Payment Amount must be greater than zero.' });
    }

    const isCheque = paymentMode === 'CHEQUE';
    const isConfirmed = !isCheque;

    if (isCheque) {
      if (!chequeDetails || !chequeDetails.chequeNumber || !chequeDetails.bankName || !chequeDetails.bankAccountNumber?.trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Cheque Number, Bank Name, and Bank Account Number are required for bulk cheque payment.' });
      }
    }

    // STRICT VALIDATION 1: Sum of member allocations must EXACTLY equal Total Amount
    let sumAllocationsPaise = 0;
    const memberIdsSeen = new Set();

    for (let i = 0; i < allocations.length; i++) {
      const item = allocations[i];
      if (!item.memberId) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: `Allocation row #${i + 1} is missing Member ID.` });
      }

      if (memberIdsSeen.has(item.memberId)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Duplicate member in allocation list: member ID ${item.memberId}. Each member must appear only once in the master allocation list.`
        });
      }
      memberIdsSeen.add(item.memberId);

      const itemAmountPaise = rupeesToPaise(item.amountRupees);
      if (itemAmountPaise <= 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Allocation for member row #${i + 1} must be greater than zero. (Zero/Negative allocations are prohibited).`
        });
      }

      sumAllocationsPaise += itemAmountPaise;
    }

    if (sumAllocationsPaise !== totalAmountPaise) {
      const diffPaise = totalAmountPaise - sumAllocationsPaise;
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Allocation Mismatch: Total Payment Amount (${formatINR(totalAmountPaise)}) does not match Sum of Member Allocations (${formatINR(sumAllocationsPaise)}). Difference: ${formatINR(diffPaise)}.`
      });
    }

    // Verify all members exist and are active
    const members = await Member.find({ _id: { $in: Array.from(memberIdsSeen) } }).populate('villageId').session(session);
    if (members.length !== memberIdsSeen.size) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'One or more selected members could not be found.' });
    }

    const memberMap = {};
    members.forEach(m => {
      memberMap[String(m._id)] = m;
    });

    // Create 1 Master Payment Transaction
    const transactionId = await generateSequentialId(PaymentTransaction, 'transactionId', 'BLK', 5);

    const transaction = (await PaymentTransaction.create([{
      transactionId,
      isBulk: true,
      payerName: payerName.trim(),
      payerMobile: payerMobile ? payerMobile.trim() : '',
      paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
      paymentMode,
      totalAmountPaise,
      chequeDetails: isCheque ? {
        chequeNumber: chequeDetails.chequeNumber.trim(),
        bankName: chequeDetails.bankName.trim(),
        bankAccountNumber: chequeDetails.bankAccountNumber.trim(),
        chequeDate: chequeDetails.chequeDate ? new Date(chequeDetails.chequeDate) : new Date()
      } : undefined,
      referenceNumber: referenceNumber ? referenceNumber.trim() : '',
      paymentStatus: isCheque ? 'RECEIVED' : 'CLEARED',
      remarks: remarks ? remarks.trim() : '',
      createdBy: req.director ? req.director._id : undefined
    }], { session }))[0];

    // Create Member Allocations linked to the master transaction
    const createdAllocations = [];

    for (const item of allocations) {
      const mem = memberMap[item.memberId];
      const allocPaise = rupeesToPaise(item.amountRupees);
      const allocationId = await generateSequentialId(PaymentAllocation, 'allocationId', 'ALLOC', 5);

      const allocation = (await PaymentAllocation.create([{
        allocationId,
        transactionId: transaction._id,
        memberId: mem._id,
        allocatedAmountPaise: allocPaise,
        status: isConfirmed ? 'CONFIRMED' : 'PROVISIONAL',
        selectedDueIds: item.selectedDueIds || (item.selectedDueId ? [item.selectedDueId] : []),
        waivedDueIds: item.waivedDueIds || (item.waivePenalty && item.selectedDueId ? [item.selectedDueId] : []),
        waivePenalty: Boolean(item.waivePenalty),
        notes: item.notes || `Bulk allocation from ${payerName}`
      }], { session }))[0];

      // Apply allocation to dues
      const applicationResult = await applyPaymentToDues({
        memberId: mem._id,
        allocationId: allocation._id,
        amountToApplyPaise: allocPaise,
        isConfirmed,
        session,
        selectedDueIds: item.selectedDueIds || (item.selectedDueId ? [item.selectedDueId] : undefined),
        waivePenalty: Boolean(item.waivePenalty),
        waivedDueIds: item.waivedDueIds || (item.waivePenalty && item.selectedDueId ? [item.selectedDueId] : [])
      });
      allocation.waivedPenalties = applicationResult.waivedPenalties;
      await allocation.save({ session });

      // If cleared immediately (cash/UPI/transfer), create member ledger entry
      if (isConfirmed) {
        const lastEntry = await LedgerEntry.findOne({ memberId: mem._id }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
        const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
        const newBalancePaise = prevBalancePaise - allocPaise;

        const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
        await LedgerEntry.create([{
          ledgerId,
          memberId: mem._id,
          transactionDate: transaction.paymentDate,
          entryType: 'BULK_PAYMENT',
          referenceId: transaction.transactionId,
          description: `Group/Bulk Payment allocated from ${payerName} via ${paymentMode} (Master Ref: ${transaction.transactionId})`,
          debitPaise: 0,
          creditPaise: allocPaise,
          runningBalancePaise: newBalancePaise,
          status: 'POSTED'
        }], { session });
      }

      createdAllocations.push({
        allocationId: allocation.allocationId,
        memberId: mem.memberId,
        fullName: mem.fullName,
        village: mem.villageId ? mem.villageId.name : '',
        allocatedAmountPaise: allocPaise,
        formattedAmount: formatINR(allocPaise)
      });
    }

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: 'BULK_PAYMENT_POSTED',
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        payerName: transaction.payerName,
        totalAmountINR: totalAmountRupees,
        paymentMode,
        membersCount: allocations.length,
        status: transaction.paymentStatus
      }
    });

    res.status(201).json({
      success: true,
      message: isCheque
        ? `Bulk cheque of ${formatINR(totalAmountPaise)} for ${allocations.length} members received. Awaiting clearance.`
        : `Bulk payment of ${formatINR(totalAmountPaise)} distributed across ${allocations.length} members successfully.`,
      receipt: {
        transactionId: transaction.transactionId,
        payerName: transaction.payerName,
        payerMobile: transaction.payerMobile,
        paymentDate: transaction.paymentDate,
        paymentMode: transaction.paymentMode,
        totalAmountPaise: transaction.totalAmountPaise,
        formattedTotalAmount: formatINR(transaction.totalAmountPaise),
        paymentStatus: transaction.paymentStatus,
        chequeDetails: transaction.chequeDetails,
        referenceNumber: transaction.referenceNumber,
        allocations: createdAllocations
      }
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

async function recalculateMemberLedger(memberId, session) {
  const entries = await LedgerEntry.find({ memberId })
    .sort({ transactionDate: 1, createdAt: 1, _id: 1 })
    .session(session);
  let runningBalancePaise = 0;

  for (const entry of entries) {
    runningBalancePaise += (entry.debitPaise || 0) - (entry.creditPaise || 0);
    if (entry.runningBalancePaise !== runningBalancePaise) {
      entry.runningBalancePaise = runningBalancePaise;
      await entry.save({ session });
    }
  }
}

async function editPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const {
      payerName,
      payerMobile,
      paymentDate,
      paymentMode,
      totalAmountRupees,
      amountRupees,
      chequeDetails,
      referenceNumber,
      remarks,
      allocations
    } = req.body;
    const transaction = await PaymentTransaction.findById(id).session(session);

    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Payment transaction not found.' });
    }

    const mode = paymentMode || transaction.paymentMode;
    const allowedModes = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'];
    const editedAllocations = allocations;
    const totalRupees = totalAmountRupees !== undefined ? totalAmountRupees : amountRupees;
    const totalPaise = rupeesToPaise(totalRupees);
    const effectiveDate = paymentDate ? new Date(paymentDate) : transaction.paymentDate;

    if (!payerName?.trim() || !allowedModes.includes(mode) || !Array.isArray(editedAllocations) || editedAllocations.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Payer name, valid payment mode, and at least one member allocation are required.' });
    }
    if (Number.isNaN(effectiveDate.getTime()) || totalPaise <= 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'A valid payment date and amount greater than zero are required.' });
    }
    if (!transaction.isBulk && editedAllocations.length !== 1) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'A single-member payment must have exactly one member allocation.' });
    }
    if (mode === 'CHEQUE' && (!chequeDetails?.chequeNumber?.trim() || !chequeDetails?.bankName?.trim() || !chequeDetails?.bankAccountNumber?.trim())) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Cheque number, bank name, and bank account number are required for cheque payments.' });
    }

    const priorReallocation = await AuditLog.findOne({
      action: 'BULK_PAYMENT_REALLOCATED',
      entityType: 'PaymentTransaction',
      entityId: String(transaction._id)
    }).session(session);
    if (priorReallocation) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: 'This payment has already been reallocated. Editing it is blocked to protect the reallocation history and member balances.'
      });
    }

    const idsSeen = new Set();
    let allocationTotalPaise = 0;
    for (let index = 0; index < editedAllocations.length; index += 1) {
      const item = editedAllocations[index];
      if (!item.memberId || !mongoose.Types.ObjectId.isValid(item.memberId)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: `Allocation row #${index + 1} has an invalid member.` });
      }
      if (idsSeen.has(String(item.memberId))) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Each member can only appear once in the allocations.' });
      }
      idsSeen.add(String(item.memberId));
      const itemPaise = rupeesToPaise(item.amountRupees);
      if (itemPaise <= 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: `Allocation row #${index + 1} must be greater than zero.` });
      }
      allocationTotalPaise += itemPaise;
    }
    if (allocationTotalPaise !== totalPaise) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'The total payment amount must exactly equal the sum of member allocations.' });
    }

    const members = await Member.find({ _id: { $in: Array.from(idsSeen) } })
      .populate('villageId')
      .session(session);
    if (members.length !== idsSeen.size) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'One or more selected members could not be found.' });
    }
    const memberMap = new Map(members.map((member) => [String(member._id), member]));

    const oldAllocations = await PaymentAllocation.find({
      transactionId: transaction._id,
      isCurrent: { $ne: false }
    }).session(session);
    const oldMemberIds = oldAllocations.map((allocation) => String(allocation.memberId));
    const previousSnapshot = {
      payerName: transaction.payerName,
      payerMobile: transaction.payerMobile,
      paymentDate: transaction.paymentDate,
      paymentMode: transaction.paymentMode,
      totalAmountPaise: transaction.totalAmountPaise,
      paymentStatus: transaction.paymentStatus,
      chequeDetails: transaction.chequeDetails?.toObject?.() || transaction.chequeDetails,
      referenceNumber: transaction.referenceNumber,
      remarks: transaction.remarks,
      allocations: oldAllocations.map((allocation) => ({
        memberId: String(allocation.memberId),
        allocatedAmountPaise: allocation.allocatedAmountPaise,
        selectedDueIds: allocation.selectedDueIds.map(String),
        waivedDueIds: allocation.waivedDueIds.map(String),
        waivedPenalties: allocation.waivedPenalties,
        waivePenalty: allocation.waivePenalty
      }))
    };

    const applications = await PaymentApplication.find({
      allocationId: { $in: oldAllocations.map((allocation) => allocation._id) }
    }).session(session);
    const affectedMemberIds = new Set([...oldMemberIds, ...Array.from(idsSeen)]);

    if (transaction.paymentStatus === 'CLEARED') {
      for (const allocation of oldAllocations) {
        const allocationApplications = applications.filter(
          (application) => String(application.allocationId) === String(allocation._id)
        );
        for (const application of allocationApplications) {
          if (application.status === 'APPLIED' && application.installmentDueId) {
            const due = await MemberInstallmentDue.findById(application.installmentDueId).session(session);
            if (due) {
              due.paidAmountPaise = Math.max(0, due.paidAmountPaise - application.appliedAmountPaise);
              due.outstandingAmountPaise = Math.max(0, due.originalAmountPaise - due.paidAmountPaise);
              due.status = due.outstandingAmountPaise === 0
                ? 'PAID'
                : due.paidAmountPaise > 0
                  ? 'PARTIAL'
                  : (new Date(due.dueDate) < new Date() ? 'OVERDUE' : 'PENDING');
              await due.save({ session });
            }
          }
          if (application.status === 'APPLIED' && application.memberPenaltyId) {
            const penalty = await MemberPenalty.findById(application.memberPenaltyId).session(session);
            if (penalty) {
              penalty.paidAmountPaise = Math.max(0, penalty.paidAmountPaise - application.appliedAmountPaise);
              penalty.outstandingAmountPaise = Math.max(0, penalty.amountPaise - penalty.paidAmountPaise - penalty.waivedAmountPaise);
              penalty.status = penalty.outstandingAmountPaise === 0
                ? (penalty.waivedAmountPaise > 0 ? 'WAIVED' : 'PAID')
                : penalty.paidAmountPaise > 0 ? 'PARTIAL' : 'PENDING';
              await penalty.save({ session });
            }
          }
          if (application.status === 'APPLIED') {
            application.status = 'REVERTED';
            await application.save({ session });
          }
        }

        const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
        await LedgerEntry.create([{
          ledgerId,
          memberId: allocation.memberId,
          transactionDate: transaction.paymentDate,
          entryType: 'REALLOCATION_ADJUSTMENT',
          referenceId: transaction.transactionId,
          description: `Payment edit reversal for ${transaction.transactionId}`,
          debitPaise: allocation.allocatedAmountPaise,
          creditPaise: 0,
          runningBalancePaise: 0,
          status: 'POSTED'
        }], { session });
      }
    }

    for (const allocation of oldAllocations) {
      for (const waivedPenalty of allocation.waivedPenalties || []) {
        const penalty = await MemberPenalty.findById(waivedPenalty.penaltyId).session(session);
        if (penalty) {
          penalty.waivedAmountPaise = Math.max(0, penalty.waivedAmountPaise - waivedPenalty.amountPaise);
          penalty.outstandingAmountPaise = Math.max(
            0,
            penalty.amountPaise - penalty.paidAmountPaise - penalty.waivedAmountPaise
          );
          penalty.status = penalty.outstandingAmountPaise === 0
            ? (penalty.waivedAmountPaise > 0 ? 'WAIVED' : 'PAID')
            : penalty.paidAmountPaise > 0 ? 'PARTIAL' : 'PENDING';
          await penalty.save({ session });
        }
      }
    }

    for (const application of applications) {
      if (application.status !== 'REVERTED') {
        application.status = 'REVERTED';
        await application.save({ session });
      }
    }
    for (const allocation of oldAllocations) {
      allocation.isCurrent = false;
      allocation.status = 'CANCELLED';
      await allocation.save({ session });
    }

    const nextStatus = ['BOUNCED', 'CANCELLED'].includes(transaction.paymentStatus)
      ? transaction.paymentStatus
      : mode === 'CHEQUE' && ['RECEIVED', 'DEPOSITED'].includes(transaction.paymentStatus)
        ? transaction.paymentStatus
        : 'CLEARED';
    const isConfirmed = nextStatus === 'CLEARED';

    transaction.payerName = payerName.trim();
    transaction.payerMobile = payerMobile ? payerMobile.trim() : '';
    transaction.paymentDate = effectiveDate;
    transaction.paymentMode = mode;
    transaction.totalAmountPaise = totalPaise;
    transaction.paymentStatus = nextStatus;
    transaction.chequeDetails = mode === 'CHEQUE' ? {
      ...(chequeDetails || {}),
      chequeNumber: chequeDetails.chequeNumber.trim(),
      bankName: chequeDetails.bankName.trim(),
      bankAccountNumber: chequeDetails.bankAccountNumber.trim(),
      chequeDate: chequeDetails.chequeDate ? new Date(chequeDetails.chequeDate) : transaction.chequeDetails?.chequeDate
    } : undefined;
    transaction.referenceNumber = referenceNumber ? referenceNumber.trim() : '';
    transaction.remarks = remarks ? remarks.trim() : '';
    if (!transaction.isBulk) {
      transaction.singleMemberId = editedAllocations[0].memberId;
    }
    await transaction.save({ session });

    const newAllocationSummaries = [];
    for (const item of editedAllocations) {
      const member = memberMap.get(String(item.memberId));
      const itemPaise = rupeesToPaise(item.amountRupees);
      const selectedDueIds = Array.isArray(item.selectedDueIds)
        ? item.selectedDueIds
        : (item.selectedDueId ? [item.selectedDueId] : []);
      const waivedDueIds = Array.isArray(item.waivedDueIds) ? item.waivedDueIds : [];
      const allocationId = await generateSequentialId(PaymentAllocation, 'allocationId', 'ALLOC', 5);
      const allocation = (await PaymentAllocation.create([{
        allocationId,
        transactionId: transaction._id,
        memberId: member._id,
        allocatedAmountPaise: itemPaise,
        status: isConfirmed ? 'CONFIRMED' : nextStatus === 'BOUNCED' ? 'REVERTED' : nextStatus === 'CANCELLED' ? 'CANCELLED' : 'PROVISIONAL',
        selectedDueIds,
        waivedDueIds,
        waivePenalty: Boolean(item.waivePenalty),
        notes: item.notes || `Edited allocation for ${member.fullName}`
      }], { session }))[0];

      if (nextStatus !== 'BOUNCED' && nextStatus !== 'CANCELLED') {
        const applicationResult = await applyPaymentToDues({
          memberId: member._id,
          allocationId: allocation._id,
          amountToApplyPaise: itemPaise,
          isConfirmed,
          session,
          selectedDueIds,
          waivePenalty: Boolean(item.waivePenalty),
          waivedDueIds
        });
        allocation.waivedPenalties = applicationResult.waivedPenalties;
        await allocation.save({ session });
      }

      if (isConfirmed) {
        const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
        await LedgerEntry.create([{
          ledgerId,
          memberId: member._id,
          transactionDate: effectiveDate,
          entryType: transaction.isBulk ? 'BULK_PAYMENT' : 'PAYMENT',
          referenceId: transaction.transactionId,
          description: `Edited payment received via ${mode} (Ref: ${referenceNumber || transaction.transactionId})`,
          debitPaise: 0,
          creditPaise: itemPaise,
          runningBalancePaise: 0,
          status: 'POSTED',
          financialYearId: transaction.financialYearId
        }], { session });
      }

      newAllocationSummaries.push({
        memberId: String(member._id),
        allocatedAmountPaise: itemPaise,
        selectedDueIds: selectedDueIds.map(String),
        waivedDueIds: waivedDueIds.map(String),
        waivePenalty: Boolean(item.waivePenalty)
      });
    }

    for (const memberId of affectedMemberIds) {
      await recalculateMemberLedger(memberId, session);
    }

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: 'PAYMENT_EDITED',
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        previous: previousSnapshot,
        updated: {
          payerName: transaction.payerName,
          payerMobile: transaction.payerMobile,
          paymentDate: transaction.paymentDate,
          paymentMode: transaction.paymentMode,
          totalAmountPaise: transaction.totalAmountPaise,
          paymentStatus: transaction.paymentStatus,
          chequeDetails: transaction.chequeDetails?.toObject?.() || transaction.chequeDetails,
          referenceNumber: transaction.referenceNumber,
          remarks: transaction.remarks,
          allocations: newAllocationSummaries
        }
      }
    });

    res.json({
      success: true,
      message: `Payment ${transaction.transactionId} updated; member dues and ledgers were synchronized.`,
      transaction
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

// 3. Get Payment Transaction by ID with all allocations and receipt breakdown
async function getPaymentById(req, res, next) {
  try {
    const transaction = await PaymentTransaction.findById(req.params.id)
      .populate('singleMemberId')
      .populate('financialYearId');

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const allocations = await PaymentAllocation.find({ transactionId: transaction._id, isCurrent: { $ne: false } })
      .populate({
        path: 'memberId',
        populate: { path: 'villageId' }
      });

    const applications = await PaymentApplication.find({
      allocationId: { $in: allocations.map((allocation) => allocation._id) }
    }).lean();
    const applicationsByAllocation = applications.reduce((groups, application) => {
      const key = String(application.allocationId);
      groups[key] = groups[key] || [];
      groups[key].push(application);
      return groups;
    }, {});

    const formattedAllocations = allocations.map(a => ({
      allocationId: a.allocationId,
      memberId: a.memberId?._id,
      member: a.memberId ? {
        id: a.memberId._id,
        memberId: a.memberId.memberId,
        fullName: a.memberId.fullName,
        village: a.memberId.villageId ? a.memberId.villageId.name : ''
      } : null,
      allocatedAmountPaise: a.allocatedAmountPaise,
      amountRupees: paiseToRupees(a.allocatedAmountPaise),
      formattedAmount: formatINR(a.allocatedAmountPaise),
      selectedDueIds: (a.selectedDueIds?.length
        ? a.selectedDueIds
        : (applicationsByAllocation[String(a._id)] || [])
          .filter((application) => application.installmentDueId && application.status !== 'REVERTED')
          .map((application) => application.installmentDueId)
      ).map(String),
      waivedDueIds: (a.waivedDueIds || []).map(String),
      waivePenalty: Boolean(a.waivePenalty),
      notes: a.notes || '',
      status: a.status
    }));

    res.json({
      success: true,
      transaction: {
        ...transaction.toObject(),
        formattedTotalAmount: formatINR(transaction.totalAmountPaise),
        totalAmountRupees: paiseToRupees(transaction.totalAmountPaise)
      },
      allocations: formattedAllocations
    });
  } catch (err) {
    next(err);
  }
}

// 4. Get Payment Transactions with filters
async function getPayments(req, res, next) {
  try {
    const { search, paymentMode, paymentStatus, isBulk, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (paymentMode) filter.paymentMode = paymentMode;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (isBulk !== undefined) filter.isBulk = isBulk === 'true';

    if (search) {
      filter.$or = [
        { transactionId: { $regex: search, $options: 'i' } },
        { payerName: { $regex: search, $options: 'i' } },
        { 'chequeDetails.chequeNumber': { $regex: search, $options: 'i' } },
        { referenceNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await PaymentTransaction.countDocuments(filter);

    const transactions = await PaymentTransaction.find(filter)
      .populate('singleMemberId', 'memberId fullName')
      .sort({ paymentDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const formatted = transactions.map(t => ({
      ...t,
      formattedTotalAmount: formatINR(t.totalAmountPaise),
      totalAmountRupees: paiseToRupees(t.totalAmountPaise)
    }));

    res.json({
      success: true,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      transactions: formatted
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createSinglePayment,
  createBulkPayment,
  editPayment,
  getPaymentById,
  getPayments
};
