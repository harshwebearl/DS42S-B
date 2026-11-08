const mongoose = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const PaymentApplication = require('../models/PaymentApplication');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const MemberPenalty = require('../models/MemberPenalty');
const Member = require('../models/Member');
const LedgerEntry = require('../models/LedgerEntry');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Helper to apply payment amount to member dues sequentially
async function applyPaymentToDues({ memberId, allocationId, amountToApplyPaise, isConfirmed, session, selectedDueIds }) {
  let remainingPaise = amountToApplyPaise;
  const applications = [];

  const dueQuery = {
    memberId,
    status: { $in: ['PENDING', 'PARTIAL', 'OVERDUE'] }
  };
  if (selectedDueIds && Array.isArray(selectedDueIds) && selectedDueIds.length > 0) {
    dueQuery._id = { $in: selectedDueIds };
  }

  // 1. First apply to selected unpaid/partial installment dues (sorted by dueDate)
  const dues = await MemberInstallmentDue.find(dueQuery).sort({ dueDate: 1 }).session(session);

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
  }

  // 2. If remaining money exists, apply to outstanding penalties
  if (remainingPaise > 0) {
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

  return { remainingPaise, applications };
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
      selectedDueIds
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
      if (!chequeDetails || !chequeDetails.chequeNumber || !chequeDetails.bankName) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Cheque Number and Bank Name are required for cheque payments.' });
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
      notes: `Single payment via ${paymentMode}`
    }], { session }))[0];

    // Apply payment to dues
    await applyPaymentToDues({
      memberId: member._id,
      allocationId: allocation._id,
      amountToApplyPaise: amountPaise,
      isConfirmed,
      session,
      selectedDueIds
    });

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
      if (!chequeDetails || !chequeDetails.chequeNumber || !chequeDetails.bankName) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Cheque Number and Bank Name are required for bulk cheque payment.' });
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
        notes: item.notes || `Bulk allocation from ${payerName}`
      }], { session }))[0];

      // Apply allocation to dues
      await applyPaymentToDues({
        memberId: mem._id,
        allocationId: allocation._id,
        amountToApplyPaise: allocPaise,
        isConfirmed,
        session,
        selectedDueIds: item.selectedDueIds
      });

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

// 3. Get Payment Transaction by ID with all allocations and receipt breakdown
async function getPaymentById(req, res, next) {
  try {
    const transaction = await PaymentTransaction.findById(req.params.id)
      .populate('singleMemberId')
      .populate('financialYearId');

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const allocations = await PaymentAllocation.find({ transactionId: transaction._id })
      .populate({
        path: 'memberId',
        populate: { path: 'villageId' }
      });

    const formattedAllocations = allocations.map(a => ({
      allocationId: a.allocationId,
      member: a.memberId ? {
        id: a.memberId._id,
        memberId: a.memberId.memberId,
        fullName: a.memberId.fullName,
        village: a.memberId.villageId ? a.memberId.villageId.name : ''
      } : null,
      allocatedAmountPaise: a.allocatedAmountPaise,
      amountRupees: paiseToRupees(a.allocatedAmountPaise),
      formattedAmount: formatINR(a.allocatedAmountPaise),
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
  getPaymentById,
  getPayments
};
