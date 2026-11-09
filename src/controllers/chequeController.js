const mongoose = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const PaymentApplication = require('../models/PaymentApplication');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const MemberPenalty = require('../models/MemberPenalty');
const LedgerEntry = require('../models/LedgerEntry');
const { paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Update Cheque Status (Deposited, Cleared, Bounced, Cancelled)
async function updateChequeStatus(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params; // PaymentTransaction ID
    const {
      status, // 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'
      depositDate,
      clearanceDate,
      clearanceReference,
      bounceDate,
      bounceReason
    } = req.body;

    if (!['DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'].includes(status)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Invalid status transition requested.' });
    }

    const transaction = await PaymentTransaction.findById(id).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Payment transaction not found.' });
    }

    if (transaction.paymentMode !== 'CHEQUE') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Only cheque transactions have clearance workflows.' });
    }

    if (transaction.paymentStatus === 'CLEARED' && status !== 'BOUNCED') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'This cheque is already marked as CLEARED.' });
    }

    const prevStatus = transaction.paymentStatus;
    transaction.chequeDetails = transaction.chequeDetails || {};

    // 1. DEPOSITED State
    if (status === 'DEPOSITED') {
      transaction.paymentStatus = 'DEPOSITED';
      transaction.chequeDetails.depositDate = depositDate ? new Date(depositDate) : new Date();
      await transaction.save({ session });
    }

    // 2. CLEARED State (CRITICAL: Confirms allocations, updates dues & writes ledger)
    else if (status === 'CLEARED') {
      if (!clearanceReference || !clearanceReference.trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Bank Clearance Reference / UTR is required to mark cheque as cleared.' });
      }

      const effectiveClearanceDate = clearanceDate ? new Date(clearanceDate) : new Date();
      transaction.paymentStatus = 'CLEARED';
      transaction.chequeDetails.clearanceDate = effectiveClearanceDate;
      transaction.chequeDetails.clearanceReference = clearanceReference.trim();
      await transaction.save({ session });

      // Find all linked allocations
      const allocations = await PaymentAllocation.find({ transactionId: transaction._id }).session(session);

      for (const alloc of allocations) {
        alloc.status = 'CONFIRMED';
        await alloc.save({ session });

        // Update applications and dues
        const applications = await PaymentApplication.find({ allocationId: alloc._id }).session(session);

        for (const app of applications) {
          app.status = 'APPLIED';
          await app.save({ session });

          if (app.installmentDueId) {
            const due = await MemberInstallmentDue.findById(app.installmentDueId).session(session);
            if (due) {
              due.paidAmountPaise += app.appliedAmountPaise;
              due.outstandingAmountPaise = Math.max(0, due.originalAmountPaise - due.paidAmountPaise);
              due.lastPaymentDate = effectiveClearanceDate;
              due.status = due.outstandingAmountPaise === 0 ? 'PAID' : 'PARTIAL';
              await due.save({ session });
            }
          }

          if (app.memberPenaltyId) {
            const pen = await MemberPenalty.findById(app.memberPenaltyId).session(session);
            if (pen) {
              pen.paidAmountPaise += app.appliedAmountPaise;
              pen.outstandingAmountPaise = Math.max(0, pen.amountPaise - pen.paidAmountPaise - pen.waivedAmountPaise);
              pen.status = pen.outstandingAmountPaise === 0 ? 'PAID' : 'PARTIAL';
              await pen.save({ session });
            }
          }
        }

        // Post Credit entry to member financial ledger
        const lastEntry = await LedgerEntry.findOne({ memberId: alloc.memberId }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
        const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
        const newBalancePaise = prevBalancePaise - alloc.allocatedAmountPaise;

        const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
        await LedgerEntry.create([{
          ledgerId,
          memberId: alloc.memberId,
          transactionDate: effectiveClearanceDate,
          entryType: transaction.isBulk ? 'BULK_PAYMENT' : 'PAYMENT',
          referenceId: transaction.transactionId,
          description: `Cheque Cleared: Cheque #${transaction.chequeDetails.chequeNumber} (${transaction.chequeDetails.bankName}, Ref: ${clearanceReference.trim()})`,
          debitPaise: 0,
          creditPaise: alloc.allocatedAmountPaise,
          runningBalancePaise: newBalancePaise,
          status: 'POSTED'
        }], { session });
      }
    }

    // 3. BOUNCED State
    else if (status === 'BOUNCED') {
      if (!bounceReason || !bounceReason.trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: 'Reason for cheque bounce is required.' });
      }

      const effectiveBounceDate = bounceDate ? new Date(bounceDate) : new Date();
      transaction.paymentStatus = 'BOUNCED';
      transaction.chequeDetails.bounceDate = effectiveBounceDate;
      transaction.chequeDetails.bounceReason = bounceReason.trim();
      await transaction.save({ session });

      // Find allocations
      const allocations = await PaymentAllocation.find({ transactionId: transaction._id }).session(session);

      for (const alloc of allocations) {
        alloc.status = 'REVERTED';
        await alloc.save({ session });

        const applications = await PaymentApplication.find({ allocationId: alloc._id }).session(session);

        for (const app of applications) {
          // If it was previously applied, revert the dues
          if (app.status === 'APPLIED') {
            if (app.installmentDueId) {
              const due = await MemberInstallmentDue.findById(app.installmentDueId).session(session);
              if (due) {
                due.paidAmountPaise = Math.max(0, due.paidAmountPaise - app.appliedAmountPaise);
                due.outstandingAmountPaise = due.originalAmountPaise - due.paidAmountPaise;
                due.status = due.paidAmountPaise === 0 ? 'PENDING' : 'PARTIAL';
                await due.save({ session });
              }
            }

            if (app.memberPenaltyId) {
              const pen = await MemberPenalty.findById(app.memberPenaltyId).session(session);
              if (pen) {
                pen.paidAmountPaise = Math.max(0, pen.paidAmountPaise - app.appliedAmountPaise);
                pen.outstandingAmountPaise = pen.amountPaise - pen.paidAmountPaise - pen.waivedAmountPaise;
                pen.status = pen.paidAmountPaise === 0 ? 'PENDING' : 'PARTIAL';
                await pen.save({ session });
              }
            }

            // Create reversal entry in ledger if it was cleared before
            const lastEntry = await LedgerEntry.findOne({ memberId: alloc.memberId }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
            const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
            const newBalancePaise = prevBalancePaise + app.appliedAmountPaise;

            const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
            await LedgerEntry.create([{
              ledgerId,
              memberId: alloc.memberId,
              transactionDate: effectiveBounceDate,
              entryType: 'CHEQUE_BOUNCE_REVERSAL',
              referenceId: transaction.transactionId,
              description: `Cheque BOUNCED Reversal: Cheque #${transaction.chequeDetails.chequeNumber} (Reason: ${bounceReason.trim()})`,
              debitPaise: app.appliedAmountPaise,
              creditPaise: 0,
              runningBalancePaise: newBalancePaise,
              status: 'POSTED'
            }], { session });
          }

          app.status = 'REVERTED';
          await app.save({ session });
        }
      }
    }

    // 4. CANCELLED State
    else if (status === 'CANCELLED') {
      transaction.paymentStatus = 'CANCELLED';
      await transaction.save({ session });

      await PaymentAllocation.updateMany(
        { transactionId: transaction._id },
        { status: 'CANCELLED' },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: `CHEQUE_STATUS_${status}`,
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        chequeNumber: transaction.chequeDetails?.chequeNumber,
        bankName: transaction.chequeDetails?.bankName,
        previousStatus: prevStatus,
        newStatus: status,
        clearanceReference,
        bounceReason
      }
    });

    res.json({
      success: true,
      message: `Cheque #${transaction.chequeDetails?.chequeNumber} status successfully updated to ${status}. All linked member records have been synchronized.`,
      transaction
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

// Get all cheques (with filter for pending / clearance queue)
async function getCheques(req, res, next) {
  try {
    const { status, search } = req.query;
    const filter = { paymentMode: 'CHEQUE' };

    if (status) {
      filter.paymentStatus = status;
    }
    if (search) {
      filter.$or = [
        { transactionId: { $regex: search, $options: 'i' } },
        { payerName: { $regex: search, $options: 'i' } },
        { 'chequeDetails.chequeNumber': { $regex: search, $options: 'i' } },
        { 'chequeDetails.bankName': { $regex: search, $options: 'i' } }
      ];
    }

    const cheques = await PaymentTransaction.find(filter)
      .populate('singleMemberId', 'memberId fullName')
      .sort({ createdAt: -1 })
      .lean();

    // Attach allocation counts and members
    const chequeIds = cheques.map(c => c._id);
    const allocations = await PaymentAllocation.find({ transactionId: { $in: chequeIds } })
      .populate('memberId', 'memberId fullName')
      .lean();

    const allocMap = {};
    allocations.forEach(a => {
      const key = String(a.transactionId);
      if (!allocMap[key]) allocMap[key] = [];
      allocMap[key].push({
        allocationId: a.allocationId,
        memberId: a.memberId?.memberId,
        fullName: a.memberId?.fullName,
        amountINR: paiseToRupees(a.allocatedAmountPaise),
        status: a.status
      });
    });

    const enriched = cheques.map(c => ({
      ...c,
      formattedTotalAmount: formatINR(c.totalAmountPaise),
      totalAmountRupees: paiseToRupees(c.totalAmountPaise),
      allocations: allocMap[String(c._id)] || []
    }));

    res.json({ success: true, count: enriched.length, cheques: enriched });
  } catch (err) {
    next(err);
  }
}

// Delete Cheque Transaction (Safely reverts dues & ledgers if CLEARED)
async function deleteCheque(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;

    const transaction = await PaymentTransaction.findById(id).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Cheque transaction not found.' });
    }

    if (transaction.paymentMode !== 'CHEQUE') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Only cheque transactions can be deleted here.' });
    }

    const chequeNum = transaction.chequeDetails?.chequeNumber || transaction.transactionId;
    const prevStatus = transaction.paymentStatus;

    // Find all linked allocations
    const allocations = await PaymentAllocation.find({ transactionId: transaction._id }).session(session);
    const allocationIds = allocations.map(a => a._id);

    // Find all linked applications
    const applications = await PaymentApplication.find({ allocationId: { $in: allocationIds } }).session(session);

    // If cheque was CLEARED, revert any applied dues and penalties
    if (prevStatus === 'CLEARED') {
      for (const app of applications) {
        if (app.status === 'APPLIED') {
          if (app.installmentDueId) {
            const due = await MemberInstallmentDue.findById(app.installmentDueId).session(session);
            if (due) {
              due.paidAmountPaise = Math.max(0, due.paidAmountPaise - app.appliedAmountPaise);
              due.outstandingAmountPaise = Math.min(due.originalAmountPaise, due.originalAmountPaise - due.paidAmountPaise);
              due.status = due.paidAmountPaise === 0 ? 'PENDING' : 'PARTIAL';
              await due.save({ session });
            }
          }

          if (app.memberPenaltyId) {
            const pen = await MemberPenalty.findById(app.memberPenaltyId).session(session);
            if (pen) {
              pen.paidAmountPaise = Math.max(0, pen.paidAmountPaise - app.appliedAmountPaise);
              pen.outstandingAmountPaise = Math.max(0, pen.amountPaise - pen.paidAmountPaise - pen.waivedAmountPaise);
              pen.status = pen.paidAmountPaise === 0 ? 'PENDING' : 'PARTIAL';
              await pen.save({ session });
            }
          }
        }
      }
    }

    // Delete any ledger entries referencing this transaction
    await LedgerEntry.deleteMany({ referenceId: transaction.transactionId }).session(session);

    // Delete payment applications
    await PaymentApplication.deleteMany({ allocationId: { $in: allocationIds } }).session(session);

    // Delete payment allocations
    await PaymentAllocation.deleteMany({ transactionId: transaction._id }).session(session);

    // Delete transaction
    await PaymentTransaction.findByIdAndDelete(transaction._id).session(session);

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: 'CHEQUE_DELETED',
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        chequeNumber: transaction.chequeDetails?.chequeNumber,
        bankName: transaction.chequeDetails?.bankName,
        totalAmountPaise: transaction.totalAmountPaise,
        status: prevStatus,
        allocationsCount: allocations.length
      }
    });

    res.json({
      success: true,
      message: `Cheque #${chequeNum} (${transaction.payerName}) deleted successfully.`
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

module.exports = {
  updateChequeStatus,
  getCheques,
  deleteCheque
};
