const Village = require('../models/Village');
const Member = require('../models/Member');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Create Village
async function createVillage(req, res, next) {
  try {
    const { name, taluka, district, state, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Village name is required.' });
    }

    const existing = await Village.findOne({ name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } });
    if (existing) {
      return res.status(400).json({ success: false, message: `Village "${name.trim()}" already exists.` });
    }

    const villageId = await generateSequentialId(Village, 'villageId', 'VIL', 3);

    const village = await Village.create({
      villageId,
      name: name.trim(),
      taluka: taluka ? taluka.trim() : '',
      district: district ? district.trim() : 'Bhavnagar',
      state: state ? state.trim() : 'Gujarat',
      description: description ? description.trim() : '',
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'VILLAGE_CREATED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId, name: village.name }
    });

    res.status(201).json({ success: true, message: 'Village created successfully', village });
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
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { villageId: { $regex: search, $options: 'i' } },
        { taluka: { $regex: search, $options: 'i' } },
        { district: { $regex: search, $options: 'i' } }
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

    if (name && name.trim().toLowerCase() !== village.name.toLowerCase()) {
      const existing = await Village.findOne({
        _id: { $ne: village._id },
        name: { $regex: new RegExp(`^${name.trim()}$`, 'i') }
      });
      if (existing) {
        return res.status(400).json({ success: false, message: `Village "${name.trim()}" already exists.` });
      }
      village.name = name.trim();
    }

    if (taluka !== undefined) village.taluka = taluka.trim();
    if (district !== undefined) village.district = district.trim();
    if (state !== undefined) village.state = state.trim();
    if (description !== undefined) village.description = description.trim();
    if (status) village.status = status;

    await village.save();

    await logAuditEvent({
      req,
      action: 'VILLAGE_UPDATED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId: village.villageId, name: village.name, status: village.status }
    });

    res.json({ success: true, message: 'Village updated successfully', village });
  } catch (err) {
    next(err);
  }
}

// Deactivate Village
async function deactivateVillage(req, res, next) {
  try {
    const village = await Village.findById(req.params.id);
    if (!village) {
      return res.status(404).json({ success: false, message: 'Village not found.' });
    }

    village.status = village.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await village.save();

    await logAuditEvent({
      req,
      action: 'VILLAGE_STATUS_TOGGLED',
      entityType: 'Village',
      entityId: village._id,
      details: { villageId: village.villageId, status: village.status }
    });

    res.json({ success: true, message: `Village status changed to ${village.status}`, village });
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

module.exports = {
  createVillage,
  getVillages,
  getVillageById,
  updateVillage,
  deactivateVillage,
  deleteVillage
};
