const Member = require('../models/Member');
const Village = require('../models/Village');
const Nominee = require('../models/Nominee');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const PaymentAllocation = require('../models/PaymentAllocation');
const MemberPenalty = require('../models/MemberPenalty');
const DeathClaim = require('../models/DeathClaim');
const LedgerEntry = require('../models/LedgerEntry');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');
const { paiseToRupees, formatINR } = require('../utils/currency');

// Create Member
async function createMember(req, res, next) {
  try {
    const {
      memberId,
      fullName,
      mobileNumber,
      email,
      villageId,
      dob,
      joiningDate,
      occupation,
      gender,
      maritalStatus,
      address,
      panCard,
      aadhaarCard,
      notes
    } = req.body;

    if (!fullName || !villageId || !dob) {
      return res.status(400).json({ success: false, message: 'Full Name, Village, and Date of Birth are required.' });
    }

    // Verify Village
    const village = await Village.findById(villageId);
    if (!village) {
      return res.status(400).json({ success: false, message: 'Invalid Village selected.' });
    }

    // Member ID: custom or auto-generated SDS-xxx
    let finalMemberId = memberId ? memberId.trim().toUpperCase() : null;
    if (finalMemberId) {
      const exists = await Member.findOne({ memberId: finalMemberId });
      if (exists) {
        return res.status(400).json({ success: false, message: `Member ID "${finalMemberId}" is already registered.` });
      }
    } else {
      finalMemberId = await generateSequentialId(Member, 'memberId', 'SDS', 3);
    }

    const member = await Member.create({
      memberId: finalMemberId,
      fullName: fullName.trim(),
      mobileNumber: mobileNumber ? mobileNumber.trim() : '',
      email: email ? email.trim().toLowerCase() : '',
      villageId,
      dob,
      joiningDate: joiningDate || new Date(),
      occupation: occupation ? occupation.trim() : '',
      gender: gender || 'MALE',
      maritalStatus: maritalStatus !== undefined ? maritalStatus : true,
      address: address ? address.trim() : '',
      panCard: panCard ? panCard.trim().toUpperCase() : '',
      aadhaarCard: aadhaarCard ? aadhaarCard.trim() : '',
      status: 'ACTIVE',
      notes: notes ? notes.trim() : ''
    });

    await logAuditEvent({
      req,
      action: 'MEMBER_CREATED',
      entityType: 'Member',
      entityId: member._id,
      details: { memberId: member.memberId, fullName: member.fullName, village: village.name }
    });

    res.status(201).json({ success: true, message: 'Member registered successfully', member });
  } catch (err) {
    next(err);
  }
}

// Bulk Import Members from Mapped Excel Data
async function bulkImportMembers(req, res, next) {
  try {
    const { members: rows, autoCreateVillages = true } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, message: 'No member records provided for import.' });
    }

    // Cache villages
    const allVillages = await Village.find({});
    const villageNameMap = {};
    for (const v of allVillages) {
      villageNameMap[v.name.trim().toLowerCase()] = v;
    }

    const InstallmentMaster = require('../models/InstallmentMaster');
    const activeInstallments = await InstallmentMaster.find({ status: 'ACTIVE' }).populate('financialYearId');

    let importedCount = 0;
    const errors = [];
    const createdMembers = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;

      if (!row.fullName || !String(row.fullName).trim()) {
        errors.push({ row: rowNum, error: 'Full Name is missing.' });
        continue;
      }

      const rawVillage = row.villageName || row.village || '';
      const vKey = String(rawVillage).trim().toLowerCase();

      let targetVillage = villageNameMap[vKey];
      if (!targetVillage && vKey) {
        if (autoCreateVillages) {
          const villageCount = await Village.countDocuments();
          const newVilId = `VIL-${String(villageCount + 1).padStart(3, '0')}`;
          targetVillage = await Village.create({
            villageId: newVilId,
            name: rawVillage.trim(),
            status: 'ACTIVE'
          });
          villageNameMap[vKey] = targetVillage;
        } else {
          errors.push({ row: rowNum, error: `Village "${rawVillage}" not found in Village Master.` });
          continue;
        }
      }

      if (!targetVillage) {
        targetVillage = allVillages[0];
      }

      // Member ID
      let finalMemberId = row.memberId ? String(row.memberId).trim().toUpperCase() : null;
      if (finalMemberId) {
        const exists = await Member.findOne({ memberId: finalMemberId });
        if (exists) {
          errors.push({ row: rowNum, error: `Member ID "${finalMemberId}" already exists.` });
          continue;
        }
      } else {
        finalMemberId = await generateSequentialId(Member, 'memberId', 'SDS', 3);
      }

      // Safe date parser
      let parsedDob = new Date('1980-01-01');
      if (row.dob) {
        // Handle numeric Excel date serial or string
        if (typeof row.dob === 'number') {
          parsedDob = new Date(Math.round((row.dob - 25569) * 86400 * 1000));
        } else {
          const d = new Date(row.dob);
          if (!isNaN(d.getTime())) {
            parsedDob = d;
          }
        }
      }

      try {
        const member = await Member.create({
          memberId: finalMemberId,
          fullName: String(row.fullName).trim(),
          mobileNumber: row.mobileNumber ? String(row.mobileNumber).trim() : '',
          email: row.email ? String(row.email).trim().toLowerCase() : '',
          villageId: targetVillage ? targetVillage._id : undefined,
          dob: parsedDob,
          joiningDate: row.joiningDate ? new Date(row.joiningDate) : new Date(),
          occupation: row.occupation ? String(row.occupation).trim() : '',
          gender: row.gender ? String(row.gender).toUpperCase() : 'MALE',
          maritalStatus: row.maritalStatus !== undefined ? Boolean(row.maritalStatus) : true,
          address: row.address ? String(row.address).trim() : '',
          panCard: row.panCard ? String(row.panCard).trim().toUpperCase() : '',
          aadhaarCard: row.aadhaarCard ? String(row.aadhaarCard).trim() : '',
          status: 'ACTIVE',
          notes: row.notes ? String(row.notes).trim() : 'Imported via Excel Bulk Upload'
        });

        // Linked Nominee creation if provided
        if (row.nomineeName && String(row.nomineeName).trim()) {
          const nomId = await generateSequentialId(Nominee, 'nomineeId', 'NOM', 3);
          await Nominee.create({
            nomineeId: nomId,
            memberId: member._id,
            nomineeName: String(row.nomineeName).trim(),
            relation: row.nomineeRelation ? String(row.nomineeRelation).trim().toUpperCase() : 'SPOUSE',
            mobileNumber: row.nomineeMobile ? String(row.nomineeMobile).trim() : '',
            sharePercentage: 100,
            priority: 1,
            status: 'ACTIVE'
          });
        }

        // Auto-generate dues for active installments of the year
        for (const inst of activeInstallments) {
          if (!inst.financialYearId) continue;
          const autoDueId = `DUE-${inst.installmentId.replace('INST-', '')}-${member.memberId}`;
          const existingDue = await MemberInstallmentDue.findOne({
            $or: [{ dueId: autoDueId }, { memberId: member._id, installmentId: inst._id }]
          });

          if (!existingDue) {
            const isOverdue = new Date() > new Date(inst.dueDate);
            await MemberInstallmentDue.create({
              dueId: autoDueId,
              memberId: member._id,
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

        createdMembers.push(member);
        importedCount++;
      } catch (rowErr) {
        errors.push({ row: rowNum, error: rowErr.message });
      }
    }

    await logAuditEvent({
      req,
      action: 'MEMBERS_BULK_IMPORTED',
      entityType: 'Member',
      entityId: createdMembers[0]?._id,
      details: { importedCount, errorCount: errors.length }
    });

    res.json({
      success: true,
      message: `Successfully imported ${importedCount} member(s). ${errors.length > 0 ? `(${errors.length} skipped due to validation errors)` : ''}`,
      importedCount,
      errors
    });
  } catch (err) {
    next(err);
  }
}

// Get Members with filters & pagination
async function getMembers(req, res, next) {
  try {
    const {
      search,
      villageId,
      status,
      page = 1,
      limit = 50,
      sortBy = 'memberId',
      sortOrder = 'asc'
    } = req.query;
    const filter = {};

    if (status) {
      filter.status = status;
    }
    if (villageId) {
      filter.villageId = villageId;
    }
    if (search) {
      filter.$or = [
        { memberId: { $regex: search, $options: 'i' } },
        { fullName: { $regex: search, $options: 'i' } },
        { mobileNumber: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Member.countDocuments(filter);

    // Sorting logic - Ascending order by default
    const allowedSortFields = ['memberId', 'fullName', 'joiningDate', 'createdAt', 'status'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'memberId';
    const sortDirection = String(sortOrder).toLowerCase() === 'desc' ? -1 : 1;
    const sortOptions = {};
    sortOptions[sortField] = sortDirection;
    if (sortField !== 'memberId') {
      sortOptions.memberId = 1;
    }

    const members = await Member.find(filter)
      .populate('villageId', 'villageId name district')
      .collation({ locale: 'en', strength: 2, numericOrdering: true })
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .lean({ virtuals: true });

    res.json({
      success: true,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      sortBy: sortField,
      sortOrder: sortDirection === -1 ? 'desc' : 'asc',
      members
    });
  } catch (err) {
    next(err);
  }
}

// Get Member by ID with detailed financial summary
async function getMemberById(req, res, next) {
  try {
    const member = await Member.findById(req.params.id).populate('villageId');
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    const nominees = await Nominee.find({ memberId: member._id, status: 'ACTIVE' });

    // Financial calculations
    const dues = await MemberInstallmentDue.find({ memberId: member._id })
      .populate('installmentId')
      .populate('financialYearId')
      .sort({ dueDate: 1 });

    const totalDuesPaise = dues.reduce((acc, d) => acc + d.originalAmountPaise, 0);
    const paidDuesPaise = dues.reduce((acc, d) => acc + d.paidAmountPaise, 0);
    const pendingDuesPaise = dues.reduce((acc, d) => acc + d.outstandingAmountPaise, 0);

    const penalties = await MemberPenalty.find({ memberId: member._id });
    const totalPenaltiesPaise = penalties.reduce((acc, p) => acc + p.amountPaise, 0);
    const paidPenaltiesPaise = penalties.reduce((acc, p) => acc + p.paidAmountPaise, 0);
    const waivedPenaltiesPaise = penalties.reduce((acc, p) => acc + p.waivedAmountPaise, 0);
    const outstandingPenaltiesPaise = penalties.reduce((acc, p) => acc + p.outstandingAmountPaise, 0);

    const totalOutstandingPaise = pendingDuesPaise + outstandingPenaltiesPaise;

    // Check Death Claim if any
    const deathClaim = await DeathClaim.findOne({ memberId: member._id });

    res.json({
      success: true,
      member: member.toObject({ virtuals: true }),
      nominees,
      financialSummary: {
        totalDuesPaise,
        paidDuesPaise,
        pendingDuesPaise,
        totalPenaltiesPaise,
        paidPenaltiesPaise,
        waivedPenaltiesPaise,
        outstandingPenaltiesPaise,
        totalOutstandingPaise,
        formattedTotalDues: formatINR(totalDuesPaise),
        formattedPaidDues: formatINR(paidDuesPaise),
        formattedPendingDues: formatINR(pendingDuesPaise),
        formattedTotalOutstanding: formatINR(totalOutstandingPaise),
        isEligibleForClaim: pendingDuesPaise === 0,
        duesBreakdown: dues
      },
      deathClaim
    });
  } catch (err) {
    next(err);
  }
}

// Update Member
async function updateMember(req, res, next) {
  try {
    const {
      fullName,
      mobileNumber,
      email,
      villageId,
      dob,
      joiningDate,
      occupation,
      gender,
      maritalStatus,
      address,
      panCard,
      aadhaarCard,
      status,
      notes
    } = req.body;

    const member = await Member.findById(req.params.id);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    if (villageId) {
      const village = await Village.findById(villageId);
      if (!village) {
        return res.status(400).json({ success: false, message: 'Invalid Village.' });
      }
      member.villageId = villageId;
    }

    if (fullName) member.fullName = fullName.trim();
    if (mobileNumber !== undefined) member.mobileNumber = mobileNumber.trim();
    if (email !== undefined) member.email = email.trim().toLowerCase();
    if (dob) member.dob = dob;
    if (joiningDate) member.joiningDate = joiningDate;
    if (occupation !== undefined) member.occupation = occupation.trim();
    if (gender) member.gender = gender;
    if (maritalStatus !== undefined) member.maritalStatus = maritalStatus;
    if (address !== undefined) member.address = address.trim();
    if (panCard !== undefined) member.panCard = panCard ? panCard.trim().toUpperCase() : '';
    if (aadhaarCard !== undefined) member.aadhaarCard = aadhaarCard ? aadhaarCard.trim() : '';
    if (status) member.status = status;
    if (notes !== undefined) member.notes = notes.trim();

    await member.save();

    await logAuditEvent({
      req,
      action: 'MEMBER_UPDATED',
      entityType: 'Member',
      entityId: member._id,
      details: { memberId: member.memberId, fullName: member.fullName, status: member.status }
    });

    res.json({ success: true, message: 'Member details updated successfully', member });
  } catch (err) {
    next(err);
  }
}

// Delete Member (Prevent deletion if financial history exists)
async function deleteMember(req, res, next) {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    // Check financial history
    const hasDues = await MemberInstallmentDue.exists({ memberId: member._id });
    const hasAllocations = await PaymentAllocation.exists({ memberId: member._id });
    const hasPenalties = await MemberPenalty.exists({ memberId: member._id });
    const hasLedger = await LedgerEntry.exists({ memberId: member._id });
    const hasClaim = await DeathClaim.exists({ memberId: member._id });

    if (hasDues || hasAllocations || hasPenalties || hasLedger || hasClaim) {
      return res.status(400).json({
        success: false,
        message: `Cannot permanently delete member ${member.memberId} (${member.fullName}). The member has existing financial/claim records. You can deactivate the member instead.`
      });
    }

    // Also remove nominees if no financial history
    await Nominee.deleteMany({ memberId: member._id });
    await Member.findByIdAndDelete(req.params.id);

    await logAuditEvent({
      req,
      action: 'MEMBER_DELETED',
      entityType: 'Member',
      entityId: member._id,
      details: { memberId: member.memberId, fullName: member.fullName }
    });

    res.json({ success: true, message: 'Member deleted successfully.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createMember,
  bulkImportMembers,
  getMembers,
  getMemberById,
  updateMember,
  deleteMember
};
