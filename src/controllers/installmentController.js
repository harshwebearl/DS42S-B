const InstallmentMaster = require('../models/InstallmentMaster');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const FinancialYear = require('../models/FinancialYear');
const Member = require('../models/Member');
const PenaltyMaster = require('../models/PenaltyMaster');
const LedgerEntry = require('../models/LedgerEntry');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Create Dynamic Installment
async function createInstallment(req, res, next) {
  try {
    const {
      financialYearId,
      installmentTitle,
      installmentNumber,
      amountRupees,
      startDate,
      dueDate,
      description,
      applicabilityRule = 'ALL_ACTIVE',
      targetVillages = []
    } = req.body;

    if (!financialYearId || !installmentTitle || amountRupees === undefined || !dueDate) {
      return res.status(400).json({ success: false, message: 'Financial Year, Title, Amount, and Due Date are required.' });
    }

    const fy = await FinancialYear.findById(financialYearId);
    if (!fy) {
      return res.status(404).json({ success: false, message: 'Financial Year not found.' });
    }

    // Auto-calculate installmentNumber if not passed
    let instNum = installmentNumber;
    if (!instNum) {
      const highestInst = await InstallmentMaster.findOne({ financialYearId }).sort({ installmentNumber: -1 });
      instNum = highestInst ? highestInst.installmentNumber + 1 : 1;
    } else {
      const exists = await InstallmentMaster.findOne({ financialYearId, installmentNumber: instNum });
      if (exists) {
        return res.status(400).json({
          success: false,
          message: `Installment #${instNum} already exists for ${fy.yearName}. Please use a different installment number.`
        });
      }
    }

    const amountPaise = rupeesToPaise(amountRupees);
    if (amountPaise <= 0) {
      return res.status(400).json({ success: false, message: 'Installment amount must be greater than zero.' });
    }

    const installmentId = `INST-${fy.yearName.replace(/[^0-9]/g, '')}-${String(instNum).padStart(2, '0')}`;

    const installment = await InstallmentMaster.create({
      installmentId,
      financialYearId,
      installmentTitle: installmentTitle.trim(),
      installmentNumber: instNum,
      amountPaise,
      startDate: startDate ? new Date(startDate) : undefined,
      dueDate: new Date(dueDate),
      description: description ? description.trim() : '',
      applicabilityRule,
      targetVillages,
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'INSTALLMENT_CREATED',
      entityType: 'InstallmentMaster',
      entityId: installment._id,
      details: { installmentId, year: fy.yearName, amountINR: amountRupees, instNum }
    });

    res.status(201).json({
      success: true,
      message: `Installment "${installmentTitle}" created successfully.`,
      installment: {
        ...installment.toObject(),
        formattedAmount: formatINR(installment.amountPaise),
        amountRupees: paiseToRupees(installment.amountPaise)
      }
    });
  } catch (err) {
    next(err);
  }
}

// Get Installments by Financial Year
async function getInstallments(req, res, next) {
  try {
    const { financialYearId } = req.query;
    const filter = {};
    if (financialYearId) {
      filter.financialYearId = financialYearId;
    }

    const installments = await InstallmentMaster.find(filter)
      .populate('financialYearId', 'fyCode yearName status')
      .populate('targetVillages', 'name villageId')
      .sort({ financialYearId: 1, installmentNumber: 1 })
      .lean();

    // Attach dues collection summary for each installment
    const installmentIds = installments.map(i => i._id);
    const duesStats = await MemberInstallmentDue.aggregate([
      { $match: { installmentId: { $in: installmentIds } } },
      {
        $group: {
          _id: '$installmentId',
          totalMembers: { $sum: 1 },
          totalDemandPaise: { $sum: '$originalAmountPaise' },
          totalCollectedPaise: { $sum: '$paidAmountPaise' },
          totalOutstandingPaise: { $sum: '$outstandingAmountPaise' },
          paidCount: { $sum: { $cond: [{ $eq: ['$status', 'PAID'] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
          partialCount: { $sum: { $cond: [{ $eq: ['$status', 'PARTIAL'] }, 1, 0] } }
        }
      }
    ]);

    const statsMap = {};
    duesStats.forEach(s => {
      statsMap[String(s._id)] = s;
    });

    const enriched = installments.map(i => {
      const stats = statsMap[String(i._id)] || {
        totalMembers: 0,
        totalDemandPaise: 0,
        totalCollectedPaise: 0,
        totalOutstandingPaise: 0,
        paidCount: 0,
        pendingCount: 0,
        partialCount: 0
      };
      return {
        ...i,
        amountRupees: paiseToRupees(i.amountPaise),
        formattedAmount: formatINR(i.amountPaise),
        stats: {
          ...stats,
          formattedDemand: formatINR(stats.totalDemandPaise),
          formattedCollected: formatINR(stats.totalCollectedPaise),
          formattedOutstanding: formatINR(stats.totalOutstandingPaise)
        }
      };
    });

    res.json({ success: true, count: enriched.length, installments: enriched });
  } catch (err) {
    next(err);
  }
}

// Generate Member-wise Installment Dues
// This generates due records for eligible members and logs debit ledger entries
async function generateMemberDues(req, res, next) {
  try {
    const { id } = req.params; // InstallmentMaster ID
    const installment = await InstallmentMaster.findById(id).populate('financialYearId');
    if (!installment) {
      return res.status(404).json({ success: false, message: 'Installment not found.' });
    }

    // Determine target members
    const memberFilter = { status: 'ACTIVE' };
    if (installment.applicabilityRule === 'VILLAGE_SPECIFIC' && installment.targetVillages?.length > 0) {
      memberFilter.villageId = { $in: installment.targetVillages };
    }

    const members = await Member.find(memberFilter);
    if (members.length === 0) {
      return res.status(400).json({ success: false, message: 'No eligible active members found for this installment.' });
    }

    let createdCount = 0;
    let skippedCount = 0;

    for (const member of members) {
      // Check if due already exists for this member & installment
      const existing = await MemberInstallmentDue.findOne({
        memberId: member._id,
        installmentId: installment._id
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      const dueId = await generateSequentialId(MemberInstallmentDue, 'dueId', 'DUE', 5);

      const due = await MemberInstallmentDue.create({
        dueId,
        memberId: member._id,
        installmentId: installment._id,
        financialYearId: installment.financialYearId._id,
        originalAmountPaise: installment.amountPaise,
        paidAmountPaise: 0,
        outstandingAmountPaise: installment.amountPaise,
        status: new Date() > new Date(installment.dueDate) ? 'OVERDUE' : 'PENDING',
        dueDate: installment.dueDate
      });

      // Calculate new running balance for member ledger
      const lastEntry = await LedgerEntry.findOne({ memberId: member._id }).sort({ transactionDate: -1, createdAt: -1 });
      const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
      const newBalancePaise = prevBalancePaise + installment.amountPaise;

      const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
      await LedgerEntry.create({
        ledgerId,
        memberId: member._id,
        transactionDate: installment.startDate || new Date(),
        entryType: 'INSTALLMENT_DUE',
        referenceId: due.dueId,
        description: `Installment Due: ${installment.installmentTitle} (${installment.financialYearId.yearName})`,
        debitPaise: installment.amountPaise,
        creditPaise: 0,
        runningBalancePaise: newBalancePaise,
        status: 'POSTED',
        financialYearId: installment.financialYearId._id
      });

      createdCount++;
    }

    await logAuditEvent({
      req,
      action: 'INSTALLMENT_DUES_GENERATED',
      entityType: 'InstallmentMaster',
      entityId: installment._id,
      details: {
        installmentTitle: installment.installmentTitle,
        year: installment.financialYearId.yearName,
        createdCount,
        skippedCount
      }
    });

    res.json({
      success: true,
      message: `Generated dues for ${createdCount} member(s). (${skippedCount} already had dues and were skipped).`,
      createdCount,
      skippedCount
    });
  } catch (err) {
    next(err);
  }
}

// Update Installment
async function updateInstallment(req, res, next) {
  try {
    const { installmentTitle, dueDate, description, status } = req.body;
    const installment = await InstallmentMaster.findById(req.params.id);
    if (!installment) {
      return res.status(404).json({ success: false, message: 'Installment not found.' });
    }

    if (installmentTitle) installment.installmentTitle = installmentTitle.trim();
    if (dueDate) installment.dueDate = new Date(dueDate);
    if (description !== undefined) installment.description = description.trim();
    if (status) installment.status = status;

    await installment.save();

    await logAuditEvent({
      req,
      action: 'INSTALLMENT_UPDATED',
      entityType: 'InstallmentMaster',
      entityId: installment._id,
      details: { installmentId: installment.installmentId, status: installment.status }
    });

    res.json({ success: true, message: 'Installment updated successfully', installment });
  } catch (err) {
    next(err);
  }
}

// Get Member Dues (All dues for a specific member)
async function getMemberDues(req, res, next) {
  try {
    const { memberId } = req.params;
    const { openOnly } = req.query;

    const member = await Member.findById(memberId);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    // Auto-ensure dues exist for all active installments of the current year
    if (member.status === 'ACTIVE') {
      const activeInstallments = await InstallmentMaster.find({ status: 'ACTIVE' }).populate('financialYearId');
      for (const inst of activeInstallments) {
        if (!inst.financialYearId) continue;
        const exists = await MemberInstallmentDue.findOne({ memberId, installmentId: inst._id });
        if (!exists) {
          const autoDueId = `DUE-${inst.installmentId.replace('INST-', '')}-${member.memberId}`;
          const dueIdColl = await MemberInstallmentDue.findOne({ dueId: autoDueId });
          const finalDueId = dueIdColl ? await generateSequentialId(MemberInstallmentDue, 'dueId', 'DUE', 5) : autoDueId;

          const today = new Date();
          const isOverdue = today > new Date(inst.dueDate);

          await MemberInstallmentDue.create({
            dueId: finalDueId,
            memberId,
            installmentId: inst._id,
            financialYearId: inst.financialYearId._id,
            originalAmountPaise: inst.amountPaise,
            paidAmountPaise: 0,
            outstandingAmountPaise: inst.amountPaise,
            status: isOverdue ? 'OVERDUE' : 'PENDING',
            dueDate: inst.dueDate
          });
        }
      }
    }

    const dues = await MemberInstallmentDue.find({ memberId })
      .populate('installmentId')
      .populate('financialYearId')
      .sort({ dueDate: 1 });

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const latePenaltyMaster = await PenaltyMaster.findOne({
      applicableRule: 'AFTER_DUE_DATE',
      status: 'ACTIVE'
    }) || await PenaltyMaster.findOne({ status: 'ACTIVE' });

    const formatted = dues.map(d => {
      const isPaid = d.status === 'PAID' || d.outstandingAmountPaise === 0;
      const dueDate = new Date(d.dueDate);
      dueDate.setHours(0, 0, 0, 0);

      const isDuePassed = todayMidnight > dueDate;

      // 3 Months Overdue Calculation
      const threeMonthsDate = new Date(dueDate);
      threeMonthsDate.setMonth(threeMonthsDate.getMonth() + 3);
      threeMonthsDate.setHours(0, 0, 0, 0);

      const isThreeMonthsOverdue = !isPaid && (todayMidnight >= threeMonthsDate);
      const daysOverdue = isDuePassed ? Math.floor((todayMidnight - dueDate) / (1000 * 60 * 60 * 24)) : 0;

      let penaltyAmountPaise = 0;
      if (isThreeMonthsOverdue && latePenaltyMaster) {
        if (latePenaltyMaster.type === 'FIXED') {
          penaltyAmountPaise = latePenaltyMaster.rateOrAmount; // stored in paise
        } else if (latePenaltyMaster.type === 'PERCENTAGE') {
          penaltyAmountPaise = Math.round((d.outstandingAmountPaise * latePenaltyMaster.rateOrAmount) / 100);
        }
      }
      const penaltyAmountRupees = paiseToRupees(penaltyAmountPaise);

      // Installment is OPEN if active, started, and not already paid
      const inst = d.installmentId;
      const startDate = inst && inst.startDate ? new Date(inst.startDate) : null;
      if (startDate) startDate.setHours(0, 0, 0, 0);
      const isStarted = !startDate || todayMidnight >= startDate;
      const isOpen = !isPaid && (!inst || inst.status === 'ACTIVE') && isStarted;

      // Status logic:
      // If paid: 'PAID'
      // If 3+ months overdue: 'OVERDUE' (Penalty applicable)
      // If due date passed (< 3 months): 'DUE'
      // If due date not passed: 'OPEN'
      let displayStatus = d.status;
      if (isPaid) {
        displayStatus = 'PAID';
      } else if (isThreeMonthsOverdue) {
        displayStatus = 'OVERDUE';
      } else if (isDuePassed) {
        displayStatus = 'DUE';
      } else {
        displayStatus = 'OPEN';
      }

      const totalWithPenaltyRupees = paiseToRupees(d.outstandingAmountPaise + penaltyAmountPaise);

      return {
        ...d.toObject(),
        formattedOriginal: formatINR(d.originalAmountPaise),
        formattedPaid: formatINR(d.paidAmountPaise),
        formattedOutstanding: formatINR(d.outstandingAmountPaise),
        originalRupees: paiseToRupees(d.originalAmountPaise),
        paidRupees: paiseToRupees(d.paidAmountPaise),
        outstandingRupees: paiseToRupees(d.outstandingAmountPaise),
        isOpen,
        isDuePassed,
        isThreeMonthsOverdue,
        threeMonthsDate: threeMonthsDate.toISOString().split('T')[0],
        daysOverdue,
        penaltyApplicable: isThreeMonthsOverdue && penaltyAmountPaise > 0,
        penaltyAmountPaise,
        penaltyAmountRupees,
        penaltyTitle: latePenaltyMaster ? latePenaltyMaster.title : 'Late Payment Penalty',
        penaltyMasterId: latePenaltyMaster ? latePenaltyMaster._id : null,
        totalWithPenaltyRupees,
        displayStatus
      };
    });

    const result = openOnly === 'true'
      ? formatted.filter(d => d.isOpen)
      : formatted;

    res.json({ success: true, dues: result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createInstallment,
  getInstallments,
  generateMemberDues,
  updateInstallment,
  getMemberDues
};
