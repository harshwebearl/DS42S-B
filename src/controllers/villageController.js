const Village = require('../models/Village');
const Member = require('../models/Member');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Helper to escape regex special characters
function escapeRegex(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

// Create Village
async function createVillage(req, res, next) {
  try {
    const { name, taluka, district, state, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Village name is required.' });
    }

    const trimmedName = name.trim();
    const existing = await Village.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, 'i') }
    });
    if (existing) {
      return res.status(400).json({ success: false, message: `Village "${trimmedName}" already exists.` });
    }

    const villageId = await generateSequentialId(Village, 'villageId', 'VIL', 3);

    const village = await Village.create({
      villageId,
      name: trimmedName,
      taluka: typeof taluka === 'string' ? taluka.trim() : (taluka || ''),
      district: typeof district === 'string' ? district.trim() : (district || ''),
      state: typeof state === 'string' && state.trim() ? state.trim() : 'Gujarat',
      description: typeof description === 'string' ? description.trim() : (description || ''),
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'VILLAGE_CREATED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId, name: village.name }
    });

    res.status(201).json({ success: true, message: 'Village created successfully', village: { ...village.toObject(), memberCount: 0 } });
  } catch (err) {
    next(err);
  }
}

// Get all villages with search and member counts
async function getVillages(req, res, next) {
  try {
    const { search, status } = req.query;
    const filter = {};

    if (status) {
      filter.status = status;
    }
    if (search && search.trim()) {
      const escaped = escapeRegex(search.trim());
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { villageId: { $regex: escaped, $options: 'i' } },
        { taluka: { $regex: escaped, $options: 'i' } },
        { district: { $regex: escaped, $options: 'i' } }
      ];
    }

    const villages = await Village.find(filter).sort({ name: 1 }).lean();

    // Attach active member counts
    const memberCounts = await Member.aggregate([
      { $group: { _id: '$villageId', count: { $sum: 1 } } }
    ]);

    const countMap = {};
    memberCounts.forEach(c => {
      countMap[String(c._id)] = c.count;
    });

    const villagesWithCounts = villages.map(v => ({
      ...v,
      memberCount: countMap[String(v._id)] || 0
    }));

    res.json({ success: true, count: villagesWithCounts.length, villages: villagesWithCounts });
  } catch (err) {
    next(err);
  }
}

// Get Village by ID
async function getVillageById(req, res, next) {
  try {
    const village = await Village.findById(req.params.id);
    if (!village) {
      return res.status(404).json({ success: false, message: 'Village not found.' });
    }
    const memberCount = await Member.countDocuments({ villageId: village._id });
    res.json({ success: true, village: { ...village.toObject(), memberCount } });
  } catch (err) {
    next(err);
  }
}

// Update Village
async function updateVillage(req, res, next) {
  try {
    const { name, taluka, district, state, description, status } = req.body;
    const village = await Village.findById(req.params.id);
    if (!village) {
      return res.status(404).json({ success: false, message: 'Village not found.' });
    }

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Village name cannot be empty.' });
      }
      const trimmedName = name.trim();
      const existing = await Village.findOne({
        _id: { $ne: village._id },
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, 'i') }
      });
      if (existing) {
        return res.status(400).json({ success: false, message: `Village "${trimmedName}" already exists.` });
      }
      village.name = trimmedName;
    }

    if (taluka !== undefined) village.taluka = typeof taluka === 'string' ? taluka.trim() : (taluka || '');
    if (district !== undefined) village.district = typeof district === 'string' ? district.trim() : '';
    if (state !== undefined) village.state = typeof state === 'string' && state.trim() ? state.trim() : village.state;
    if (description !== undefined) village.description = typeof description === 'string' ? description.trim() : (description || '');
    if (status && ['ACTIVE', 'INACTIVE'].includes(status)) village.status = status;

    await village.save();

    const memberCount = await Member.countDocuments({ villageId: village._id });
    const updatedVillageObj = { ...village.toObject(), memberCount };

    await logAuditEvent({
      req,
      action: 'VILLAGE_UPDATED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId: village.villageId, name: village.name, status: village.status }
    });

    res.json({ success: true, message: 'Village updated successfully', village: updatedVillageObj });
  } catch (err) {
    next(err);
  }
}

// Deactivate / Toggle Village Status
async function deactivateVillage(req, res, next) {
  try {
    const village = await Village.findById(req.params.id);
    if (!village) {
      return res.status(404).json({ success: false, message: 'Village not found.' });
    }

    village.status = village.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await village.save();

    const memberCount = await Member.countDocuments({ villageId: village._id });
    const updatedVillageObj = { ...village.toObject(), memberCount };

    await logAuditEvent({
      req,
      action: 'VILLAGE_STATUS_TOGGLED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId: village.villageId, status: village.status }
    });

    res.json({ success: true, message: `Village status changed to ${village.status}`, village: updatedVillageObj });
  } catch (err) {
    next(err);
  }
}

// Delete Village (Prevent deletion if members are linked)
async function deleteVillage(req, res, next) {
  try {
    const village = await Village.findById(req.params.id);
    if (!village) {
      return res.status(404).json({ success: false, message: 'Village not found.' });
    }

    const linkedMembersCount = await Member.countDocuments({ villageId: village._id });
    if (linkedMembersCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot permanently delete village "${village.name}". It is linked to ${linkedMembersCount} existing member(s). You can deactivate it instead.`
      });
    }

    await Village.findByIdAndDelete(req.params.id);

    await logAuditEvent({
      req,
      action: 'VILLAGE_DELETED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId: village.villageId, name: village.name }
    });

    res.json({ success: true, message: 'Village deleted successfully.' });
  } catch (err) {
    next(err);
  }
}

// Bulk Update Village Status
async function bulkUpdateVillageStatus(req, res, next) {
  try {
    const { villageIds, status } = req.body;
    if (!Array.isArray(villageIds) || villageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one village.' });
    }
    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be ACTIVE or INACTIVE.' });
    }

    const result = await Village.updateMany(
      { _id: { $in: villageIds } },
      { $set: { status } }
    );

    await logAuditEvent({
      req,
      action: 'VILLAGES_BULK_STATUS_UPDATED',
      entityType: 'Village',
      details: { count: result.modifiedCount, status, villageIds }
    });

    res.json({
      success: true,
      message: `Successfully updated ${result.modifiedCount} village(s) to ${status}.`,
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    next(err);
  }
}

// Bulk Delete Villages (Skips any with linked members)
async function bulkDeleteVillages(req, res, next) {
  try {
    const { villageIds } = req.body;
    if (!Array.isArray(villageIds) || villageIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one village.' });
    }

    const villages = await Village.find({ _id: { $in: villageIds } });
    if (villages.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching villages found.' });
    }

    // Check which ones have linked members
    const memberCounts = await Member.aggregate([
      { $match: { villageId: { $in: villages.map(v => v._id) } } },
      { $group: { _id: '$villageId', count: { $sum: 1 } } }
    ]);
    const busyVillageIds = new Set(memberCounts.map(c => String(c._id)));

    const toDeleteIds = [];
    const skippedVillages = [];

    villages.forEach(v => {
      if (busyVillageIds.has(String(v._id))) {
        const cnt = memberCounts.find(c => String(c._id) === String(v._id))?.count || 1;
        skippedVillages.push({ id: v._id, name: v.name, count: cnt });
      } else {
        toDeleteIds.push(v._id);
      }
    });

    let deletedCount = 0;
    if (toDeleteIds.length > 0) {
      const delResult = await Village.deleteMany({ _id: { $in: toDeleteIds } });
      deletedCount = delResult.deletedCount;

      await logAuditEvent({
        req,
        action: 'VILLAGES_BULK_DELETED',
        entityType: 'Village',
        details: { deletedCount, deletedIds: toDeleteIds }
      });
    }

    let message = '';
    if (deletedCount > 0 && skippedVillages.length === 0) {
      message = `Successfully deleted ${deletedCount} village(s).`;
    } else if (deletedCount > 0 && skippedVillages.length > 0) {
      message = `Deleted ${deletedCount} village(s). ${skippedVillages.length} village(s) skipped because they have active linked members.`;
    } else {
      message = `None of the selected villages could be deleted because all of them have linked members (${skippedVillages.map(s => `${s.name} (${s.count})`).join(', ')}).`;
    }

    res.json({
      success: true,
      message,
      deletedCount,
      skippedCount: skippedVillages.length,
      skippedVillages
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createVillage,
  getVillages,
  getVillageById,
  updateVillage,
  deactivateVillage,
  deleteVillage,
  bulkUpdateVillageStatus,
  bulkDeleteVillages
};
