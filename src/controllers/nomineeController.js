const Nominee = require('../models/Nominee');
const Member = require('../models/Member');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Add Nominee
async function createNominee(req, res, next) {
  try {
    const {
      memberId,
      nomineeName,
      mobileNumber,
      relation,
      aadhaarCard,
      panCard,
      sharePercentage = 100,
      priority = 1
    } = req.body;

    if (!memberId || !nomineeName || !relation) {
      return res.status(400).json({ success: false, message: 'Member ID, Nominee Name, and Relation are required.' });
    }

    const member = await Member.findById(memberId);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    // Check existing active nominees share percentage sum
    const existingNominees = await Nominee.find({ memberId: member._id, status: 'ACTIVE' });
    const currentTotalShare = existingNominees.reduce((acc, n) => acc + (n.sharePercentage || 0), 0);

    if (currentTotalShare + Number(sharePercentage) > 100) {
      return res.status(400).json({
        success: false,
        message: `Total share percentage cannot exceed 100%. Currently allocated: ${currentTotalShare}%, attempted to add: ${sharePercentage}%.`
      });
    }

    const nomineeId = await generateSequentialId(Nominee, 'nomineeId', 'NOM', 3);

    const nominee = await Nominee.create({
      nomineeId,
      memberId: member._id,
      nomineeName: nomineeName.trim(),
      mobileNumber: mobileNumber ? mobileNumber.trim() : '',
      relation,
      aadhaarCard: aadhaarCard ? aadhaarCard.trim() : '',
      panCard: panCard ? panCard.trim().toUpperCase() : '',
      sharePercentage: Number(sharePercentage),
      priority: Number(priority),
      status: 'ACTIVE',
      historyNotes: [{
        action: 'CREATED',
        changedAt: new Date(),
        changedBy: req.director ? req.director.name : 'Director',
        details: 'Initial nominee registration'
      }]
    });

    await logAuditEvent({
      req,
      action: 'NOMINEE_ADDED',
      entityType: 'Nominee',
      entityId: nominee._id,
      details: { nomineeId, nomineeName: nominee.nomineeName, memberId: member.memberId }
    });

    res.status(201).json({ success: true, message: 'Nominee added successfully', nominee });
  } catch (err) {
    next(err);
  }
}

// Get Nominees for a Member
async function getNomineesByMember(req, res, next) {
  try {
    const { memberId } = req.params;
    const nominees = await Nominee.find({ memberId }).sort({ priority: 1, createdAt: 1 });
    res.json({ success: true, nominees });
  } catch (err) {
    next(err);
  }
}

// Update Nominee
async function updateNominee(req, res, next) {
  try {
    const { nomineeName, mobileNumber, relation, aadhaarCard, panCard, sharePercentage, priority, status } = req.body;
    const nominee = await Nominee.findById(req.params.id);
    if (!nominee) {
      return res.status(404).json({ success: false, message: 'Nominee not found.' });
    }

    const changes = [];
    if (nomineeName && nomineeName.trim() !== nominee.nomineeName) {
      changes.push(`Name changed from "${nominee.nomineeName}" to "${nomineeName.trim()}"`);
      nominee.nomineeName = nomineeName.trim();
    }
    if (relation && relation !== nominee.relation) {
      changes.push(`Relation changed from "${nominee.relation}" to "${relation}"`);
      nominee.relation = relation;
    }
    if (sharePercentage !== undefined && Number(sharePercentage) !== nominee.sharePercentage) {
      // Validate total share
      const otherNominees = await Nominee.find({
        memberId: nominee.memberId,
        _id: { $ne: nominee._id },
        status: 'ACTIVE'
      });
      const otherShare = otherNominees.reduce((acc, n) => acc + (n.sharePercentage || 0), 0);
      if (otherShare + Number(sharePercentage) > 100) {
        return res.status(400).json({
          success: false,
          message: `Total share percentage cannot exceed 100%. Other nominees: ${otherShare}%, requested: ${sharePercentage}%.`
        });
      }
      changes.push(`Share changed from ${nominee.sharePercentage}% to ${sharePercentage}%`);
      nominee.sharePercentage = Number(sharePercentage);
    }
    if (mobileNumber !== undefined) nominee.mobileNumber = mobileNumber.trim();
    if (aadhaarCard !== undefined) nominee.aadhaarCard = aadhaarCard.trim();
    if (panCard !== undefined) nominee.panCard = panCard.trim().toUpperCase();
    if (priority !== undefined) nominee.priority = Number(priority);
    if (status && status !== nominee.status) {
      changes.push(`Status changed to ${status}`);
      nominee.status = status;
    }

    if (changes.length > 0) {
      nominee.historyNotes.push({
        action: 'UPDATED',
        changedAt: new Date(),
        changedBy: req.director ? req.director.name : 'Director',
        details: changes.join('; ')
      });
    }

    await nominee.save();

    await logAuditEvent({
      req,
      action: 'NOMINEE_UPDATED',
      entityType: 'Nominee',
      entityId: nominee._id,
      details: { nomineeId: nominee.nomineeId, changes }
    });

    res.json({ success: true, message: 'Nominee updated successfully', nominee });
  } catch (err) {
    next(err);
  }
}

// Deactivate Nominee
async function deactivateNominee(req, res, next) {
  try {
    const nominee = await Nominee.findById(req.params.id);
    if (!nominee) {
      return res.status(404).json({ success: false, message: 'Nominee not found.' });
    }

    nominee.status = nominee.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    nominee.historyNotes.push({
      action: 'STATUS_TOGGLED',
      changedAt: new Date(),
      changedBy: req.director ? req.director.name : 'Director',
      details: `Status set to ${nominee.status}`
    });

    await nominee.save();

    res.json({ success: true, message: `Nominee status changed to ${nominee.status}`, nominee });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createNominee,
  getNomineesByMember,
  updateNominee,
  deactivateNominee
};
