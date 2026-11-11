const Member = require('../models/Member');
const Village = require('../models/Village');
const FinancialYear = require('../models/FinancialYear');
const InstallmentMaster = require('../models/InstallmentMaster');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const DeathClaim = require('../models/DeathClaim');
const ClaimCheque = require('../models/ClaimCheque');
const { paiseToRupees, formatINR } = require('../utils/currency');

async function getDashboardStats(req, res, next) {
  try {
    // 1. Member Statistics
    const totalMembers = await Member.countDocuments();
    const activeMembers = await Member.countDocuments({ status: 'ACTIVE' });
    const inactiveMembers = await Member.countDocuments({ status: 'INACTIVE' });
    const deceasedMembers = await Member.countDocuments({ status: 'DECEASED' });

    // Village-wise distribution
    const villageDistribution = await Member.aggregate([
      {
        $group: {
          _id: '$villageId',
          count: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'villages',
          localField: '_id',
          foreignField: '_id',
          as: 'village'
        }
      },
      { $unwind: '$village' },
      {
        $project: {
          villageName: '$village.name',
          count: 1
        }
      },
      { $sort: { count: -1 } },
      { $limit: 8 }
    ]);

    // 2. Current financial year installment statistics for active members
    const currentFinancialYear = await FinancialYear.findOne({ isCurrent: true })
      || await FinancialYear.findOne({ status: 'ACTIVE' }).sort({ startDate: -1 });
    const duesAgg = currentFinancialYear
      ? await MemberInstallmentDue.aggregate([
          { $match: { financialYearId: currentFinancialYear._id } },
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
          {
            $group: {
              _id: null,
              totalDemandPaise: { $sum: '$originalAmountPaise' },
              totalCollectedPaise: { $sum: '$paidAmountPaise' },
              totalOutstandingPaise: { $sum: '$outstandingAmountPaise' },
              overdueCount: { $sum: { $cond: [{ $eq: ['$status', 'OVERDUE'] }, 1, 0] } },
              partialCount: { $sum: { $cond: [{ $eq: ['$status', 'PARTIAL'] }, 1, 0] } },
              paidCount: { $sum: { $cond: [{ $eq: ['$status', 'PAID'] }, 1, 0] } },
              pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } }
            }
          }
        ])
      : [];
    const installmentStats = duesAgg[0] || {
      totalDemandPaise: 0,
      totalCollectedPaise: 0,
      totalOutstandingPaise: 0,
      overdueCount: 0,
      partialCount: 0,
      paidCount: 0,
      pendingCount: 0
    };

    // 3. Payment Mode Statistics (from Master PaymentTransactions, NEVER double counted!)
    const paymentModeAgg = await PaymentTransaction.aggregate([
      { $match: { paymentStatus: 'CLEARED' } },
      {
        $group: {
          _id: '$paymentMode',
          totalPaise: { $sum: '$totalAmountPaise' },
          count: { $sum: 1 }
        }
      }
    ]);

    const modeStats = {
      CASH: { count: 0, paise: 0 },
      UPI: { count: 0, paise: 0 },
      BANK_TRANSFER: { count: 0, paise: 0 },
      CHEQUE: { count: 0, paise: 0 }
    };
    paymentModeAgg.forEach(item => {
      if (modeStats[item._id]) {
        modeStats[item._id] = { count: item.count, paise: item.totalPaise };
      }
    });

    // Cheque statuses
    const pendingCheques = await PaymentTransaction.find({
      paymentMode: 'CHEQUE',
      paymentStatus: { $in: ['RECEIVED', 'DEPOSITED'] }
    });
    const pendingChequesCount = pendingCheques.length;
    const pendingChequesPaise = pendingCheques.reduce((acc, c) => acc + c.totalAmountPaise, 0);

    const bouncedCheques = await PaymentTransaction.find({
      paymentMode: 'CHEQUE',
      paymentStatus: 'BOUNCED'
    });
    const bouncedChequesCount = bouncedCheques.length;
    const bouncedChequesPaise = bouncedCheques.reduce((acc, c) => acc + c.totalAmountPaise, 0);

    const bulkTransactionsCount = await PaymentTransaction.countDocuments({ isBulk: true });

    // 4. Death Claim Statistics
    const totalClaims = await DeathClaim.countDocuments();
    const pendingClaims = await DeathClaim.countDocuments({ claimStatus: 'PENDING_REVIEW' });
    const eligibleClaims = await DeathClaim.countDocuments({ eligibilityStatus: 'ELIGIBLE' });
    const approvedClaims = await DeathClaim.countDocuments({ claimStatus: { $in: ['APPROVED', 'DISBURSED'] } });

    const claimChequesIssued = await ClaimCheque.countDocuments({ chequeStatus: { $in: ['ISSUED', 'HANDED_OVER', 'DEPOSITED', 'CLEARED'] } });
    const claimChequesCleared = await ClaimCheque.countDocuments({ chequeStatus: 'CLEARED' });

    const disbursedAgg = await ClaimCheque.aggregate([
      { $match: { chequeStatus: 'CLEARED' } },
      { $group: { _id: null, totalDisbursedPaise: { $sum: '$chequeAmountPaise' } } }
    ]);
    const totalDisbursedPaise = disbursedAgg[0] ? disbursedAgg[0].totalDisbursedPaise : 0;

    // 5. Recent 6 Transactions
    const recentTransactions = await PaymentTransaction.find()
      .populate('singleMemberId', 'memberId fullName')
      .sort({ paymentDate: -1, createdAt: -1 })
      .limit(6)
      .lean();

    const formattedRecent = recentTransactions.map(t => ({
      ...t,
      formattedAmount: formatINR(t.totalAmountPaise),
      amountRupees: paiseToRupees(t.totalAmountPaise)
    }));

    // 6. Recent Pending Cheques Action Queue
    const pendingChequeQueue = await PaymentTransaction.find({
      paymentMode: 'CHEQUE',
      paymentStatus: { $in: ['RECEIVED', 'DEPOSITED'] }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const formattedChequeQueue = pendingChequeQueue.map(c => ({
      ...c,
      formattedAmount: formatINR(c.totalAmountPaise),
      amountRupees: paiseToRupees(c.totalAmountPaise)
    }));

    res.json({
      success: true,
      data: {
        memberStats: {
          total: totalMembers,
          active: activeMembers,
          inactive: inactiveMembers,
          deceased: deceasedMembers,
          villageDistribution
        },
        installmentStats: {
          ...installmentStats,
          formattedDemand: formatINR(installmentStats.totalDemandPaise),
          formattedCollected: formatINR(installmentStats.totalCollectedPaise),
          formattedOutstanding: formatINR(installmentStats.totalOutstandingPaise),
          demandRupees: paiseToRupees(installmentStats.totalDemandPaise),
          collectedRupees: paiseToRupees(installmentStats.totalCollectedPaise),
          outstandingRupees: paiseToRupees(installmentStats.totalOutstandingPaise)
        },
        paymentStats: {
          byMode: {
            cash: { ...modeStats.CASH, formatted: formatINR(modeStats.CASH.paise) },
            upi: { ...modeStats.UPI, formatted: formatINR(modeStats.UPI.paise) },
            bankTransfer: { ...modeStats.BANK_TRANSFER, formatted: formatINR(modeStats.BANK_TRANSFER.paise) },
            cheque: { ...modeStats.CHEQUE, formatted: formatINR(modeStats.CHEQUE.paise) }
          },
          pendingChequesCount,
          pendingChequesPaise,
          formattedPendingCheques: formatINR(pendingChequesPaise),
          bouncedChequesCount,
          bouncedChequesPaise,
          formattedBouncedCheques: formatINR(bouncedChequesPaise),
          bulkTransactionsCount
        },
        claimStats: {
          totalClaims,
          pendingClaims,
          eligibleClaims,
          approvedClaims,
          claimChequesIssued,
          claimChequesCleared,
          totalDisbursedPaise,
          formattedDisbursed: formatINR(totalDisbursedPaise),
          disbursedRupees: paiseToRupees(totalDisbursedPaise)
        },
        recentTransactions: formattedRecent,
        pendingChequeQueue: formattedChequeQueue
      }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getDashboardStats
};
