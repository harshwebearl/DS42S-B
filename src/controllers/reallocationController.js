const mongoose = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const Member = require('../models/Member');
const LedgerEntry = require('../models/LedgerEntry');
const DeathClaim = require('../models/DeathClaim');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Reallocate Bulk Payment
async function reallocateBulkPayment(req, res, next) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params; // Master PaymentTransaction ID
    const {
      reasonForChange,
      newAllocations // Array of { memberId, amountRupees }
    } = req.body;

    if (!reasonForChange || !reasonForChange.trim()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Reason for change/reallocation is strictly required.' });
    }

    if (!Array.isArray(newAllocations) || newAllocations.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'New member allocations are required.' });
    }

    const transaction = await PaymentTransaction.findById(id).session(session);
    if (!transaction) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Payment transaction not found.' });
    }

    // STRICT VALIDATION: Total amount must remain EXACTLY identical!
    let sumNewPaise = 0;
    const newMemberMap = {};

    for (let i = 0; i < newAllocations.length; i++) {
      const item = newAllocations[i];
      if (!item.memberId) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: `Allocation row #${i + 1} is missing Member ID.` });
      }

      const paise = rupeesToPaise(item.amountRupees);
      if (paise <= 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: `Allocation for member row #${i + 1} must be > 0.` });
      }

      sumNewPaise += paise;
      newMemberMap[String(item.memberId)] = paise;
    }

    if (sumNewPaise !== transaction.totalAmountPaise) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: `Total payment amount must remain unchanged at ${formatINR(transaction.totalAmountPaise)}. Revised allocations sum to ${formatINR(sumNewPaise)}.`
      });
    }

    // Existing allocations
    const oldAllocations = await PaymentAllocation.find({ transactionId: transaction._id }).session(session);
    const oldMemberMap = {};
    oldAllocations.forEach(a => {
      oldMemberMap[String(a.memberId)] = {
        allocationDoc: a,
        amountPaise: a.allocatedAmountPaise
      };
    });

    // Check if any member has a disbursed death claim
    const allMemberIds = Array.from(new Set([...Object.keys(oldMemberMap), ...Object.keys(newMemberMap)]));
    const lockedClaims = await DeathClaim.find({
      memberId: { $in: allMemberIds },
      claimStatus: 'DISBURSED'
    }).session(session);

    if (lockedClaims.length > 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Cannot reallocate: One or more affected members have a finalized and disbursed Death Claim.'
      });
    }

    const auditHistory = [];
    const isCleared = transaction.paymentStatus === 'CLEARED';

    // 1. Process members whose allocation is reduced or removed
    for (const [memId, oldData] of Object.entries(oldMemberMap)) {
      const newAmountPaise = newMemberMap[memId] || 0;
      const oldAmountPaise = oldData.amountPaise;

      if (newAmountPaise < oldAmountPaise) {
        const diffPaise = oldAmountPaise - newAmountPaise;

        if (isCleared) {
          // Member received LESS money now -> increase their liability (Debit)
          const lastEntry = await LedgerEntry.findOne({ memberId: memId }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
          const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
          const newBalancePaise = prevBalancePaise + diffPaise;

          const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
          await LedgerEntry.create([{
            ledgerId,
            memberId: memId,
            transactionDate: new Date(),
            entryType: 'REALLOCATION_ADJUSTMENT',
            referenceId: transaction.transactionId,
            description: `Reallocation Reduction: Decreased by ${formatINR(diffPaise)} for Transaction ${transaction.transactionId}. Reason: ${reasonForChange.trim()}`,
            debitPaise: diffPaise,
            creditPaise: 0,
            runningBalancePaise: newBalancePaise,
            status: 'POSTED'
          }], { session });

          // Also adjust dues back to outstanding
          const dues = await MemberInstallmentDue.find({ memberId: memId, paidAmountPaise: { $gt: 0 } }).sort({ dueDate: -1 }).session(session);
          let toUnpay = diffPaise;
          for (const d of dues) {
            if (toUnpay <= 0) break;
            const takeBack = Math.min(toUnpay, d.paidAmountPaise);
            d.paidAmountPaise -= takeBack;
            d.outstandingAmountPaise += takeBack;
            d.status = d.paidAmountPaise === 0 ? 'PENDING' : 'PARTIAL';
            await d.save({ session });
            toUnpay -= takeBack;
          }
        }

        if (newAmountPaise === 0) {
          oldData.allocationDoc.status = 'REVERTED';
          await oldData.allocationDoc.save({ session });
        } else {
          oldData.allocationDoc.allocatedAmountPaise = newAmountPaise;
          await oldData.allocationDoc.save({ session });
        }

        auditHistory.push({
          memberId: memId,
          change: 'REDUCED',
          oldAmountINR: paiseToRupees(oldAmountPaise),
          newAmountINR: paiseToRupees(newAmountPaise),
          diffINR: paiseToRupees(diffPaise)
        });
      }
    }

    // 2. Process members whose allocation is increased or newly added
    for (const [memId, newAmountPaise] of Object.entries(newMemberMap)) {
      const oldAmountPaise = oldMemberMap[memId] ? oldMemberMap[memId].amountPaise : 0;

      if (newAmountPaise > oldAmountPaise) {
        const diffPaise = newAmountPaise - oldAmountPaise;

        if (oldMemberMap[memId]) {
          oldMemberMap[memId].allocationDoc.allocatedAmountPaise = newAmountPaise;
          oldMemberMap[memId].allocationDoc.status = isCleared ? 'CONFIRMED' : 'PROVISIONAL';
          await oldMemberMap[memId].allocationDoc.save({ session });
        } else {
          const allocationId = await generateSequentialId(PaymentAllocation, 'allocationId', 'ALLOC', 5);
          await PaymentAllocation.create([{
            allocationId,
            transactionId: transaction._id,
            memberId: memId,
            allocatedAmountPaise: newAmountPaise,
            status: isCleared ? 'CONFIRMED' : 'PROVISIONAL',
            notes: `Added during reallocation: ${reasonForChange}`
          }], { session });
        }

        if (isCleared) {
          // Member received MORE money now -> decrease their liability (Credit)
          const lastEntry = await LedgerEntry.findOne({ memberId: memId }).sort({ transactionDate: -1, createdAt: -1 }).session(session);
          const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
          const newBalancePaise = prevBalancePaise - diffPaise;

          const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
          await LedgerEntry.create([{
            ledgerId,
            memberId: memId,
            transactionDate: new Date(),
            entryType: 'REALLOCATION_ADJUSTMENT',
            referenceId: transaction.transactionId,
            description: `Reallocation Addition: Increased by ${formatINR(diffPaise)} for Transaction ${transaction.transactionId}. Reason: ${reasonForChange.trim()}`,
            debitPaise: 0,
            creditPaise: diffPaise,
            runningBalancePaise: newBalancePaise,
            status: 'POSTED'
          }], { session });

          // Apply extra money to pending dues
          const dues = await MemberInstallmentDue.find({
            memberId: memId,
            status: { $in: ['PENDING', 'PARTIAL', 'OVERDUE'] }
          }).sort({ dueDate: 1 }).session(session);

          let toPay = diffPaise;
          for (const d of dues) {
            if (toPay <= 0) break;
            const pay = Math.min(toPay, d.outstandingAmountPaise);
            d.paidAmountPaise += pay;
            d.outstandingAmountPaise -= pay;
            d.status = d.outstandingAmountPaise === 0 ? 'PAID' : 'PARTIAL';
            await d.save({ session });
            toPay -= pay;
          }
        }

        auditHistory.push({
          memberId: memId,
          change: 'INCREASED',
          oldAmountINR: paiseToRupees(oldAmountPaise),
          newAmountINR: paiseToRupees(newAmountPaise),
          diffINR: paiseToRupees(diffPaise)
        });
      }
    }

    await session.commitTransaction();
    session.endSession();

    await logAuditEvent({
      req,
      action: 'BULK_PAYMENT_REALLOCATED',
      entityType: 'PaymentTransaction',
      entityId: transaction._id,
      details: {
        transactionId: transaction.transactionId,
        totalAmountINR: paiseToRupees(transaction.totalAmountPaise),
        reasonForChange: reasonForChange.trim(),
        auditHistory
      }
    });

    res.json({
      success: true,
      message: 'Bulk payment successfully reallocated. All member accounts and ledger entries have been updated.',
      auditHistory
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
}

module.exports = {
  reallocateBulkPayment
};
