const PenaltyMaster = require('../models/PenaltyMaster');
const MemberPenalty = require('../models/MemberPenalty');
const Member = require('../models/Member');
const LedgerEntry = require('../models/LedgerEntry');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Create Penalty Master
async function createPenaltyMaster(req, res, next) {
  try {
    const { title, type, rateOrAmount, applicableRule, gracePeriodDays, description } = req.body;
    if (!title || rateOrAmount === undefined) {
      return res.status(400).json({ success: false, message: 'Penalty Title and Rate/Amount are required.' });
    }

    const penaltyId = await generateSequentialId(PenaltyMaster, 'penaltyId', 'PEN', 3);

    const val = type === 'FIXED' ? rupeesToPaise(rateOrAmount) : Number(rateOrAmount);

    const pm = await PenaltyMaster.create({
      penaltyId,
      title: title.trim(),
      type: type || 'FIXED',
      rateOrAmount: val,
      applicableRule: applicableRule || 'MANUAL',
      gracePeriodDays: Number(gracePeriodDays) || 0,
      description: description ? description.trim() : '',
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'PENALTY_MASTER_CREATED',
      entityType: 'PenaltyMaster',
      entityId: pm._id,
      details: { penaltyId, title: pm.title }
    });

    res.status(201).json({ success: true, message: 'Penalty rule created successfully', penaltyMaster: pm });
  } catch (err) {
    next(err);
  }
}

// Get Penalty Masters
async function getPenaltyMasters(req, res, next) {
  try {
    const list = await PenaltyMaster.find().sort({ createdAt: -1 });
    const formatted = list.map(p => ({
      ...p.toObject(),
      displayRate: p.type === 'FIXED' ? formatINR(p.rateOrAmount) : `${p.rateOrAmount}%`,
      rateOrAmountRupees: p.type === 'FIXED' ? paiseToRupees(p.rateOrAmount) : p.rateOrAmount
    }));
    res.json({ success: true, count: formatted.length, penaltyMasters: formatted });
  } catch (err) {
    next(err);
  }
}

// Update Penalty Master
async function updatePenaltyMaster(req, res, next) {
  try {
    const { id } = req.params;
    const { title, type, rateOrAmount, applicableRule, gracePeriodDays, description, status } = req.body;

    const pm = await PenaltyMaster.findById(id);
    if (!pm) {
      return res.status(404).json({ success: false, message: 'Penalty rule not found.' });
    }

    if (title) pm.title = title.trim();
    if (type) pm.type = type;
    if (rateOrAmount !== undefined) {
      pm.rateOrAmount = (type || pm.type) === 'FIXED' ? rupeesToPaise(rateOrAmount) : Number(rateOrAmount);
    }
    if (applicableRule) pm.applicableRule = applicableRule;
    if (gracePeriodDays !== undefined) pm.gracePeriodDays = Number(gracePeriodDays) || 0;
    if (description !== undefined) pm.description = description ? description.trim() : '';
    if (status) pm.status = status;

    await pm.save();

    await logAuditEvent({
      req,
      action: 'PENALTY_MASTER_UPDATED',
      entityType: 'PenaltyMaster',
      entityId: pm._id,
      details: { penaltyId: pm.penaltyId, title: pm.title, status: pm.status }
    });

    res.json({
      success: true,
      message: 'Penalty rule updated successfully',
      penaltyMaster: {
        ...pm.toObject(),
        displayRate: pm.type === 'FIXED' ? formatINR(pm.rateOrAmount) : `${pm.rateOrAmount}%`,
        rateOrAmountRupees: pm.type === 'FIXED' ? paiseToRupees(pm.rateOrAmount) : pm.rateOrAmount
      }
    });
  } catch (err) {
    next(err);
  }
}

// Toggle Penalty Master Status
async function togglePenaltyMasterStatus(req, res, next) {
  try {
    const { id } = req.params;
    const pm = await PenaltyMaster.findById(id);
    if (!pm) {
      return res.status(404).json({ success: false, message: 'Penalty rule not found.' });
    }

    pm.status = pm.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await pm.save();

    await logAuditEvent({
      req,
      action: 'PENALTY_MASTER_STATUS_CHANGED',
      entityType: 'PenaltyMaster',
      entityId: pm._id,
      details: { penaltyId: pm.penaltyId, title: pm.title, newStatus: pm.status }
    });

    res.json({
      success: true,
      message: `Penalty rule marked as ${pm.status}`,
      penaltyMaster: pm
    });
  } catch (err) {
    next(err);
  }
}

// Delete Penalty Master
async function deletePenaltyMaster(req, res, next) {
  try {
    const { id } = req.params;
    const pm = await PenaltyMaster.findById(id);
    if (!pm) {
      return res.status(404).json({ success: false, message: 'Penalty rule not found.' });
    }

    // Check if assigned to any member
    const inUse = await MemberPenalty.exists({ penaltyMasterId: pm._id });
    if (inUse) {
      pm.status = 'INACTIVE';
      await pm.save();
      return res.json({
        success: true,
        message: 'Penalty rule is linked to member records and cannot be permanently deleted. It has been deactivated instead.',
        penaltyMaster: pm
      });
    }

    await pm.deleteOne();

    await logAuditEvent({
      req,
      action: 'PENALTY_MASTER_DELETED',
      entityType: 'PenaltyMaster',
      entityId: pm._id,
      details: { penaltyId: pm.penaltyId, title: pm.title }
    });

    res.json({
      success: true,
      message: `Penalty rule ${pm.penaltyId} deleted successfully.`
    });
  } catch (err) {
    next(err);
  }
}

// Assign Penalty to Member
async function assignPenaltyToMember(req, res, next) {
  try {
    const { memberId, penaltyMasterId, amountRupees, reason, title } = req.body;
    if (!memberId || amountRupees === undefined) {
      return res.status(400).json({ success: false, message: 'Member ID and Amount are required.' });
    }

    const member = await Member.findById(memberId);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    const amountPaise = rupeesToPaise(amountRupees);
    if (amountPaise <= 0) {
      return res.status(400).json({ success: false, message: 'Penalty amount must be greater than zero.' });
    }

    let penaltyTitle = title;
    if (!penaltyTitle && penaltyMasterId) {
      const pm = await PenaltyMaster.findById(penaltyMasterId);
      if (pm) penaltyTitle = pm.title;
    }
    if (!penaltyTitle) penaltyTitle = 'Late Payment / General Penalty';

    const memberPenaltyId = await generateSequentialId(MemberPenalty, 'memberPenaltyId', 'MPEN', 5);

    const penalty = await MemberPenalty.create({
      memberPenaltyId,
      memberId: member._id,
      penaltyMasterId: penaltyMasterId || null,
      title: penaltyTitle,
      amountPaise,
      paidAmountPaise: 0,
      waivedAmountPaise: 0,
      outstandingAmountPaise: amountPaise,
      status: 'PENDING',
      reason: reason ? reason.trim() : ''
    });

    // Update Ledger: Penalty creates a debit (increases outstanding balance)
    const lastEntry = await LedgerEntry.findOne({ memberId: member._id }).sort({ transactionDate: -1, createdAt: -1 });
    const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
    const newBalancePaise = prevBalancePaise + amountPaise;

    const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
    await LedgerEntry.create({
      ledgerId,
      memberId: member._id,
      transactionDate: new Date(),
      entryType: 'PENALTY',
      referenceId: penalty.memberPenaltyId,
      description: `Penalty Assessed: ${penaltyTitle} (${reason || 'Standard'})`,
      debitPaise: amountPaise,
      creditPaise: 0,
      runningBalancePaise: newBalancePaise,
      status: 'POSTED'
    });

    await logAuditEvent({
      req,
      action: 'MEMBER_PENALTY_ASSIGNED',
      entityType: 'MemberPenalty',
      entityId: penalty._id,
      details: { memberPenaltyId, memberId: member.memberId, amountINR: amountRupees, reason }
    });

    res.status(201).json({
      success: true,
      message: `Penalty of ${formatINR(amountPaise)} assigned to member ${member.memberId}`,
      penalty
    });
  } catch (err) {
    next(err);
  }
}

// Waive Penalty with reason
async function waivePenalty(req, res, next) {
  try {
    const { id } = req.params;
    const { waiverReason } = req.body;

    if (!waiverReason || !waiverReason.trim()) {
      return res.status(400).json({ success: false, message: 'A valid reason for penalty waiver is required.' });
    }

    const penalty = await MemberPenalty.findById(id).populate('memberId');
    if (!penalty) {
      return res.status(404).json({ success: false, message: 'Penalty not found.' });
    }

    if (penalty.status === 'PAID') {
      return res.status(400).json({ success: false, message: 'Cannot waive a penalty that has already been paid.' });
    }

    if (penalty.status === 'WAIVED') {
      return res.status(400).json({ success: false, message: 'This penalty has already been waived.' });
    }

    const waiveAmountPaise = penalty.outstandingAmountPaise;

    penalty.waivedAmountPaise += waiveAmountPaise;
    penalty.outstandingAmountPaise = 0;
    penalty.status = 'WAIVED';
    penalty.waiverReason = waiverReason.trim();
    penalty.waivedAt = new Date();
    penalty.waivedBy = req.director ? req.director._id : null;
    await penalty.save();

    // Ledger Entry: Waiver credits the member (reduces liability)
    const lastEntry = await LedgerEntry.findOne({ memberId: penalty.memberId._id }).sort({ transactionDate: -1, createdAt: -1 });
    const prevBalancePaise = lastEntry ? lastEntry.runningBalancePaise : 0;
    const newBalancePaise = prevBalancePaise - waiveAmountPaise;

    const ledgerId = await generateSequentialId(LedgerEntry, 'ledgerId', 'LED', 5);
    await LedgerEntry.create({
      ledgerId,
      memberId: penalty.memberId._id,
      transactionDate: new Date(),
      entryType: 'PENALTY_WAIVER',
      referenceId: penalty.memberPenaltyId,
      description: `Penalty Waived: ${penalty.title} (Reason: ${waiverReason.trim()})`,
      debitPaise: 0,
      creditPaise: waiveAmountPaise,
      runningBalancePaise: newBalancePaise,
      status: 'POSTED'
    });

    await logAuditEvent({
      req,
      action: 'MEMBER_PENALTY_WAIVED',
      entityType: 'MemberPenalty',
      entityId: penalty._id,
      details: {
        memberPenaltyId: penalty.memberPenaltyId,
        memberId: penalty.memberId.memberId,
        waivedAmountINR: paiseToRupees(waiveAmountPaise),
        waiverReason: waiverReason.trim()
      }
    });

    res.json({
      success: true,
      message: `Penalty successfully waived (${formatINR(waiveAmountPaise)}).`,
      penalty
    });
  } catch (err) {
    next(err);
  }
}

// Get Penalties for a Member
async function getMemberPenalties(req, res, next) {
  try {
    const { memberId } = req.params;
    const penalties = await MemberPenalty.find({ memberId }).sort({ createdAt: -1 });
    const formatted = penalties.map(p => ({
      ...p.toObject(),
      formattedAmount: formatINR(p.amountPaise),
      formattedPaid: formatINR(p.paidAmountPaise),
      formattedWaived: formatINR(p.waivedAmountPaise),
      formattedOutstanding: formatINR(p.outstandingAmountPaise)
    }));
    res.json({ success: true, penalties: formatted });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPenaltyMaster,
  getPenaltyMasters,
  updatePenaltyMaster,
  togglePenaltyMasterStatus,
  deletePenaltyMaster,
  assignPenaltyToMember,
  waivePenalty,
  getMemberPenalties
};
