const xlsx = require('xlsx');
const Member = require('../models/Member');
const Village = require('../models/Village');
const FinancialYear = require('../models/FinancialYear');
const InstallmentMaster = require('../models/InstallmentMaster');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const PaymentTransaction = require('../models/PaymentTransaction');
const PaymentAllocation = require('../models/PaymentAllocation');
const MemberPenalty = require('../models/MemberPenalty');
const DeathClaim = require('../models/DeathClaim');
const ClaimCheque = require('../models/ClaimCheque');
const LedgerEntry = require('../models/LedgerEntry');
const { paiseToRupees, formatINR } = require('../utils/currency');

// Dispatcher for report generation
async function generateReportData(reportType, query = {}) {
  const { villageId, financialYearId, startDate, endDate, status, memberId } = query;

  switch (reportType) {
    // 1. All Members Report
    case 'all-members': {
      const filter = {};
      if (villageId) filter.villageId = villageId;
      if (status) filter.status = status;
      const data = await Member.find(filter).populate('villageId', 'name').sort({ memberId: 1 }).lean();
      return data.map(m => ({
        'Member ID': m.memberId,
        'Full Name': m.fullName,
        'Village': m.villageId?.name || '',
        'Mobile Number': m.mobileNumber || '-',
        'Date of Birth': m.dob ? new Date(m.dob).toLocaleDateString() : '-',
        'Joining Date': m.joiningDate ? new Date(m.joiningDate).toLocaleDateString() : '-',
        'Status': m.status,
        'Masked Aadhaar': m.aadhaarCard ? `XXXX-XXXX-${m.aadhaarCard.slice(-4)}` : '-',
        'Masked PAN': m.panCard ? `${m.panCard.slice(0, 5)}****${m.panCard.slice(-1)}` : '-'
      }));
    }

    // 2. Village-wise Member Report
    case 'village-wise-members': {
      const villages = await Village.find().sort({ name: 1 }).lean();
      const rows = [];
      for (const v of villages) {
        const total = await Member.countDocuments({ villageId: v._id });
        const active = await Member.countDocuments({ villageId: v._id, status: 'ACTIVE' });
        const deceased = await Member.countDocuments({ villageId: v._id, status: 'DECEASED' });
        rows.push({
          'Village ID': v.villageId,
          'Village Name': v.name,
          'Taluka': v.taluka || '-',
          'District': v.district || 'Bhavnagar',
          'Total Members': total,
          'Active Members': active,
          'Deceased Members': deceased,
          'Status': v.status
        });
      }
      return rows;
    }

    // 3. Financial Year-wise Collection Report
    case 'fy-collection': {
      const years = await FinancialYear.find().sort({ startDate: -1 }).lean();
      const rows = [];
      for (const y of years) {
        const installments = await InstallmentMaster.find({ financialYearId: y._id });
        const instIds = installments.map(i => i._id);
        const agg = await MemberInstallmentDue.aggregate([
          { $match: { installmentId: { $in: instIds } } },
          {
            $group: {
              _id: null,
              totalDemand: { $sum: '$originalAmountPaise' },
              totalCollected: { $sum: '$paidAmountPaise' },
              totalPending: { $sum: '$outstandingAmountPaise' }
            }
          }
        ]);
        const stats = agg[0] || { totalDemand: 0, totalCollected: 0, totalPending: 0 };
        rows.push({
          'FY Code': y.fyCode,
          'Financial Year': y.yearName,
          'Installments Count': installments.length,
          'Total Demand (₹)': paiseToRupees(stats.totalDemand),
          'Total Collected (₹)': paiseToRupees(stats.totalCollected),
          'Total Pending (₹)': paiseToRupees(stats.totalPending),
          'Status': y.status
        });
      }
      return rows;
    }

    // 4. Installment-wise Pending Report
    case 'installment-pending': {
      const filter = { status: { $in: ['PENDING', 'PARTIAL', 'OVERDUE'] } };
      if (financialYearId) filter.financialYearId = financialYearId;

      const dues = await MemberInstallmentDue.find(filter)
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .populate('installmentId')
        .populate('financialYearId')
        .sort({ dueDate: 1 })
        .lean();

      return dues.map(d => ({
        'Due ID': d.dueId,
        'Member ID': d.memberId?.memberId || '',
        'Member Name': d.memberId?.fullName || '',
        'Village': d.memberId?.villageId?.name || '',
        'Financial Year': d.financialYearId?.yearName || '',
        'Installment': d.installmentId?.installmentTitle || '',
        'Original Amount (₹)': paiseToRupees(d.originalAmountPaise),
        'Paid Amount (₹)': paiseToRupees(d.paidAmountPaise),
        'Pending Amount (₹)': paiseToRupees(d.outstandingAmountPaise),
        'Due Date': d.dueDate ? new Date(d.dueDate).toLocaleDateString() : '',
        'Status': d.status
      }));
    }

    // 5. Member-wise Payment Statement
    case 'member-payment-statement': {
      const filter = { status: 'CONFIRMED' };
      if (memberId) filter.memberId = memberId;

      const allocations = await PaymentAllocation.find(filter)
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .populate('transactionId')
        .sort({ createdAt: -1 })
        .lean();

      return allocations.map(a => ({
        'Allocation ID': a.allocationId,
        'Master Transaction ID': a.transactionId?.transactionId || '',
        'Member ID': a.memberId?.memberId || '',
        'Member Name': a.memberId?.fullName || '',
        'Village': a.memberId?.villageId?.name || '',
        'Payment Date': a.transactionId?.paymentDate ? new Date(a.transactionId.paymentDate).toLocaleDateString() : '',
        'Payment Mode': a.transactionId?.paymentMode || '',
        'Allocated Amount (₹)': paiseToRupees(a.allocatedAmountPaise),
        'Payer Name': a.transactionId?.payerName || '',
        'Cheque No': a.transactionId?.chequeDetails?.chequeNumber || '-'
      }));
    }

    // 6. Penalty Report
    case 'penalty-report': {
      const penalties = await MemberPenalty.find()
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .sort({ createdAt: -1 })
        .lean();

      return penalties.map(p => ({
        'Penalty ID': p.memberPenaltyId,
        'Member ID': p.memberId?.memberId || '',
        'Member Name': p.memberId?.fullName || '',
        'Title': p.title,
        'Amount (₹)': paiseToRupees(p.amountPaise),
        'Paid (₹)': paiseToRupees(p.paidAmountPaise),
        'Waived (₹)': paiseToRupees(p.waivedAmountPaise),
        'Outstanding (₹)': paiseToRupees(p.outstandingAmountPaise),
        'Status': p.status,
        'Waiver Reason': p.waiverReason || '-'
      }));
    }

    // 7. Single Payment Report
    case 'single-payments': {
      const txns = await PaymentTransaction.find({ isBulk: false })
        .populate({ path: 'singleMemberId', populate: { path: 'villageId' } })
        .sort({ paymentDate: -1 })
        .lean();

      return txns.map(t => ({
        'Transaction ID': t.transactionId,
        'Member ID': t.singleMemberId?.memberId || '-',
        'Member Name': t.singleMemberId?.fullName || '-',
        'Village': t.singleMemberId?.villageId?.name || '-',
        'Payer Name': t.payerName,
        'Payment Date': new Date(t.paymentDate).toLocaleDateString(),
        'Payment Mode': t.paymentMode,
        'Amount (₹)': paiseToRupees(t.totalAmountPaise),
        'Status': t.paymentStatus,
        'Cheque No': t.chequeDetails?.chequeNumber || '-'
      }));
    }

    // 8. Bulk Payment Report
    case 'bulk-payments': {
      const txns = await PaymentTransaction.find({ isBulk: true })
        .sort({ paymentDate: -1 })
        .lean();

      const rows = [];
      for (const t of txns) {
        const count = await PaymentAllocation.countDocuments({ transactionId: t._id });
        rows.push({
          'Bulk Transaction ID': t.transactionId,
          'Payer Name': t.payerName,
          'Payer Mobile': t.payerMobile || '-',
          'Payment Date': new Date(t.paymentDate).toLocaleDateString(),
          'Payment Mode': t.paymentMode,
          'Total Cheque/Receipt Amount (₹)': paiseToRupees(t.totalAmountPaise),
          'Allocated Members Count': count,
          'Cheque Number': t.chequeDetails?.chequeNumber || '-',
          'Bank Name': t.chequeDetails?.bankName || '-',
          'Status': t.paymentStatus
        });
      }
      return rows;
    }

    // 9. Cheque Clearance Report
    case 'cheque-clearance': {
      const cheques = await PaymentTransaction.find({ paymentMode: 'CHEQUE' })
        .sort({ 'chequeDetails.clearanceDate': -1, paymentDate: -1 })
        .lean();

      return cheques.map(c => ({
        'Transaction ID': c.transactionId,
        'Is Bulk': c.isBulk ? 'YES' : 'NO',
        'Payer Name': c.payerName,
        'Cheque Number': c.chequeDetails?.chequeNumber || '',
        'Bank Name': c.chequeDetails?.bankName || '',
        'Amount (₹)': paiseToRupees(c.totalAmountPaise),
        'Cheque Date': c.chequeDetails?.chequeDate ? new Date(c.chequeDetails.chequeDate).toLocaleDateString() : '-',
        'Deposit Date': c.chequeDetails?.depositDate ? new Date(c.chequeDetails.depositDate).toLocaleDateString() : '-',
        'Clearance Date': c.chequeDetails?.clearanceDate ? new Date(c.chequeDetails.clearanceDate).toLocaleDateString() : '-',
        'Clearance Ref': c.chequeDetails?.clearanceReference || '-',
        'Status': c.paymentStatus
      }));
    }

    // 10. Bounced Cheque Report
    case 'bounced-cheques': {
      const bounced = await PaymentTransaction.find({ paymentMode: 'CHEQUE', paymentStatus: 'BOUNCED' })
        .sort({ 'chequeDetails.bounceDate': -1 })
        .lean();

      return bounced.map(b => ({
        'Transaction ID': b.transactionId,
        'Payer Name': b.payerName,
        'Cheque Number': b.chequeDetails?.chequeNumber || '',
        'Bank Name': b.chequeDetails?.bankName || '',
        'Amount (₹)': paiseToRupees(b.totalAmountPaise),
        'Bounce Date': b.chequeDetails?.bounceDate ? new Date(b.chequeDetails.bounceDate).toLocaleDateString() : '-',
        'Bounce Reason': b.chequeDetails?.bounceReason || 'Insufficient Funds'
      }));
    }

    // 11. Death Claim Report
    case 'death-claims': {
      const claims = await DeathClaim.find()
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .sort({ registrationDate: -1 })
        .lean();

      return claims.map(c => ({
        'Claim ID': c.claimId,
        'Member ID': c.memberId?.memberId || '',
        'Member Name': c.memberId?.fullName || '',
        'Village': c.memberId?.villageId?.name || '',
        'Date of Death': new Date(c.dateOfDeath).toLocaleDateString(),
        'Nominee Name': c.nomineeName,
        'Nominee Relation': c.nomineeRelation,
        'Eligibility Status': c.eligibilityStatus,
        'Claim Status': c.claimStatus,
        'Approved Amount (₹)': paiseToRupees(c.approvedAmountPaise),
        'Pending Dues at Death (₹)': paiseToRupees(c.pendingInstallmentsPaise)
      }));
    }

    // 12. Claim Eligibility Report
    case 'claim-eligibility': {
      const claims = await DeathClaim.find()
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .sort({ registrationDate: -1 })
        .lean();

      return claims.map(c => ({
        'Claim ID': c.claimId,
        'Member ID': c.memberId?.memberId || '',
        'Member Name': c.memberId?.fullName || '',
        'Eligibility Status': c.eligibilityStatus,
        'Eligibility Reason': c.eligibilityReason || '',
        'Required Installments (₹)': paiseToRupees(c.totalRequiredInstallmentsPaise),
        'Confirmed Paid (₹)': paiseToRupees(c.confirmedPaidInstallmentsPaise),
        'Unpaid Dues (₹)': paiseToRupees(c.pendingInstallmentsPaise),
        'Can Issue Cheque': c.pendingInstallmentsPaise === 0 ? 'YES' : 'NO'
      }));
    }

    // 13. Claim Cheque Issue Report
    case 'claim-cheques': {
      const cheques = await ClaimCheque.find()
        .populate({ path: 'memberId', populate: { path: 'villageId' } })
        .populate('claimId')
        .sort({ issueDate: -1 })
        .lean();

      return cheques.map(c => ({
        'Cheque Record ID': c.claimChequeId,
        'Claim ID': c.claimId?.claimId || '',
        'Member ID': c.memberId?.memberId || '',
        'Deceased Name': c.memberId?.fullName || '',
        'Beneficiary Name': c.beneficiaryName,
        'Cheque Number': c.chequeNumber,
        'Bank Name': c.bankName,
        'Cheque Amount (₹)': paiseToRupees(c.chequeAmountPaise),
        'Issue Date': new Date(c.issueDate).toLocaleDateString(),
        'Handover Date': c.handoverDate ? new Date(c.handoverDate).toLocaleDateString() : '-',
        'Clearance Date': c.clearanceDate ? new Date(c.clearanceDate).toLocaleDateString() : '-',
        'Status': c.chequeStatus
      }));
    }

    // 14. Outstanding Balance Report
    case 'outstanding-balances': {
      const members = await Member.find({ status: { $in: ['ACTIVE', 'DECEASED'] } })
        .populate('villageId', 'name')
        .sort({ memberId: 1 })
        .lean();

      const rows = [];
      for (const m of members) {
        const lastEntry = await LedgerEntry.findOne({ memberId: m._id }).sort({ transactionDate: -1, createdAt: -1 });
        const balance = lastEntry ? lastEntry.runningBalancePaise : 0;
        if (balance > 0) {
          rows.push({
            'Member ID': m.memberId,
            'Full Name': m.fullName,
            'Village': m.villageId?.name || '',
            'Mobile Number': m.mobileNumber || '-',
            'Status': m.status,
            'Outstanding Balance (₹)': paiseToRupees(balance)
          });
        }
      }
      return rows;
    }

    // 15. Annual Collection Summary
    case 'annual-summary': {
      const years = await FinancialYear.find().sort({ startDate: -1 }).lean();
      const rows = [];
      for (const y of years) {
        const txns = await PaymentTransaction.aggregate([
          {
            $match: {
              paymentDate: { $gte: y.startDate, $lte: y.endDate },
              paymentStatus: 'CLEARED'
            }
          },
          {
            $group: {
              _id: '$paymentMode',
              total: { $sum: '$totalAmountPaise' },
              count: { $sum: 1 }
            }
          }
        ]);
        let cash = 0, upi = 0, bank = 0, cheque = 0;
        txns.forEach(t => {
          if (t._id === 'CASH') cash = t.total;
          if (t._id === 'UPI') upi = t.total;
          if (t._id === 'BANK_TRANSFER') bank = t.total;
          if (t._id === 'CHEQUE') cheque = t.total;
        });
        const grandTotal = cash + upi + bank + cheque;
        rows.push({
          'Financial Year': y.yearName,
          'Start Date': new Date(y.startDate).toLocaleDateString(),
          'End Date': new Date(y.endDate).toLocaleDateString(),
          'Cash (₹)': paiseToRupees(cash),
          'UPI (₹)': paiseToRupees(upi),
          'Bank Transfer (₹)': paiseToRupees(bank),
          'Cheque (₹)': paiseToRupees(cheque),
          'Grand Total (₹)': paiseToRupees(grandTotal)
        });
      }
      return rows;
    }

    default:
      return [];
  }
}

// Get Report as JSON for web view
async function getReport(req, res, next) {
  try {
    const { type } = req.params;
    const data = await generateReportData(type, req.query);
    res.json({
      success: true,
      reportType: type,
      count: data.length,
      data
    });
  } catch (err) {
    next(err);
  }
}

// Export Report as Excel Workbook (.xlsx)
async function exportReportExcel(req, res, next) {
  try {
    const { type } = req.params;
    const data = await generateReportData(type, req.query);

    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Report');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename="DS24G_${type}_${Date.now()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getReport,
  exportReportExcel
};
