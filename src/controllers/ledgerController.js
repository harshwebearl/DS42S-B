const LedgerEntry = require('../models/LedgerEntry');
const Member = require('../models/Member');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const PaymentAllocation = require('../models/PaymentAllocation');
const MemberPenalty = require('../models/MemberPenalty');
const { paiseToRupees, formatINR } = require('../utils/currency');

// Get Member Financial Ledger
async function getMemberLedger(req, res, next) {
  try {
    const { memberId } = req.params;
    const member = await Member.findById(memberId).populate('villageId');
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    const entries = await LedgerEntry.find({ memberId: member._id })
      .populate('financialYearId', 'yearName fyCode')
      .sort({ transactionDate: 1, createdAt: 1 })
      .lean();

    // Dynamically calculate and verify running balances and totals
    let runningCalcPaise = 0;
    let totalDebitPaise = 0;
    let totalCreditPaise = 0;

    const formattedEntries = entries.map(entry => {
      const debit = entry.debitPaise || 0;
      const credit = entry.creditPaise || 0;
      runningCalcPaise += (debit - credit);
      totalDebitPaise += debit;
      totalCreditPaise += credit;

      return {
        ...entry,
        formattedDebit: debit > 0 ? formatINR(debit) : '-',
        formattedCredit: credit > 0 ? formatINR(credit) : '-',
        formattedBalance: formatINR(runningCalcPaise),
        debitRupees: paiseToRupees(debit),
        creditRupees: paiseToRupees(credit),
        balanceRupees: paiseToRupees(runningCalcPaise)
      };
    });

    // Also get all payment allocations for complete payment history
    const allocations = await PaymentAllocation.find({ memberId: member._id })
      .populate({
        path: 'transactionId',
        select: 'transactionId isBulk payerName paymentDate paymentMode chequeDetails referenceNumber paymentStatus'
      })
      .sort({ createdAt: -1 })
      .lean();

    const paymentHistory = allocations.map(a => ({
      allocationId: a.allocationId,
      transactionId: a.transactionId?.transactionId,
      isBulk: a.transactionId?.isBulk,
      payerName: a.transactionId?.payerName,
      paymentDate: a.transactionId?.paymentDate,
      paymentMode: a.transactionId?.paymentMode,
      allocatedAmountPaise: a.allocatedAmountPaise,
      formattedAmount: formatINR(a.allocatedAmountPaise),
      paymentStatus: a.transactionId?.paymentStatus,
      allocationStatus: a.status,
      chequeNumber: a.transactionId?.chequeDetails?.chequeNumber,
      bankName: a.transactionId?.chequeDetails?.bankName,
      clearanceDate: a.transactionId?.chequeDetails?.clearanceDate
    }));

    res.json({
      success: true,
      member: {
        id: member._id,
        memberId: member.memberId,
        fullName: member.fullName,
        village: member.villageId ? member.villageId.name : '',
        status: member.status
      },
      summary: {
        totalDebitPaise,
        totalCreditPaise,
        outstandingBalancePaise: runningCalcPaise,
        formattedTotalDebit: formatINR(totalDebitPaise),
        formattedTotalCredit: formatINR(totalCreditPaise),
        formattedOutstandingBalance: formatINR(runningCalcPaise),
        totalDebitRupees: paiseToRupees(totalDebitPaise),
        totalCreditRupees: paiseToRupees(totalCreditPaise),
        outstandingBalanceRupees: paiseToRupees(runningCalcPaise)
      },
      entries: formattedEntries,
      paymentHistory
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMemberLedger
};
