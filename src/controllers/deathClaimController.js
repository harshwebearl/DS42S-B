const DeathClaim = require('../models/DeathClaim');
const Member = require('../models/Member');
const Nominee = require('../models/Nominee');
const MemberInstallmentDue = require('../models/MemberInstallmentDue');
const MemberPenalty = require('../models/MemberPenalty');
const ClaimEligibilityPolicy = require('../models/ClaimEligibilityPolicy');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Helper to check member death claim eligibility
async function evaluateClaimEligibility(memberId, dateOfDeath) {
  const deathDate = new Date(dateOfDeath);

  // 1. Fetch active claim policy
  let policy = await ClaimEligibilityPolicy.findOne({ status: 'ACTIVE' });
  if (!policy) {
    policy = await ClaimEligibilityPolicy.findOne().sort({ effectiveDate: -1 });
  }

  // 2. Installments up to date of death
  const dues = await MemberInstallmentDue.find({
    memberId,
    dueDate: { $lte: deathDate }
  }).populate('installmentId');

  const totalRequiredInstallmentsPaise = dues.reduce((acc, d) => acc + d.originalAmountPaise, 0);
  const confirmedPaidInstallmentsPaise = dues.reduce((acc, d) => acc + d.paidAmountPaise, 0);
  const pendingInstallmentsPaise = Math.max(0, totalRequiredInstallmentsPaise - confirmedPaidInstallmentsPaise);

  // 3. Penalties
  const penalties = await MemberPenalty.find({
    memberId,
    status: { $in: ['PENDING', 'PARTIAL'] }
  });
  const pendingPenaltiesPaise = penalties.reduce((acc, p) => acc + p.outstandingAmountPaise, 0);

  // 4. Strict business rule: Must NOT have unpaid required installments to proceed to cheque issuance
  let eligibilityStatus = 'ELIGIBLE';
  let eligibilityReason = 'All required installments are fully paid and cleared as per society rules.';

  if (pendingInstallmentsPaise > 0) {
    eligibilityStatus = 'INELIGIBLE_PENDING_DUES';
    eligibilityReason = `Member has ${formatINR(pendingInstallmentsPaise)} in unpaid required installment dues as of death date. Cheque cannot be issued until dues are resolved.`;
  } else if (policy && policy.penaltyEligibilityRule === 'NO_UNPAID_PENALTIES' && pendingPenaltiesPaise > 0) {
    eligibilityStatus = 'INELIGIBLE_PENDING_DUES';
    eligibilityReason = `Member has ${formatINR(pendingPenaltiesPaise)} in unpaid penalties. Society rules require all penalties to be settled.`;
  }

  return {
    policy,
    totalRequiredInstallmentsPaise,
    confirmedPaidInstallmentsPaise,
    pendingInstallmentsPaise,
    pendingPenaltiesPaise,
    eligibilityStatus,
    eligibilityReason,
    duesBreakdown: dues
  };
}

// 1. Check Eligibility (Pre-flight calculation for UI before filing claim)
async function checkEligibility(req, res, next) {
  try {
    const { memberId, dateOfDeath } = req.body;
    if (!memberId || !dateOfDeath) {
      return res.status(400).json({ success: false, message: 'Member ID and Date of Death are required.' });
    }

    const member = await Member.findById(memberId).populate('villageId');
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    const nominees = await Nominee.find({ memberId: member._id, status: 'ACTIVE' }).sort({ priority: 1 });

    const evaluation = await evaluateClaimEligibility(member._id, dateOfDeath);

    res.json({
      success: true,
      member: {
        id: member._id,
        memberId: member.memberId,
        fullName: member.fullName,
        village: member.villageId ? member.villageId.name : ''
      },
      nominees,
      evaluation: {
        ...evaluation,
        formattedRequired: formatINR(evaluation.totalRequiredInstallmentsPaise),
        formattedPaid: formatINR(evaluation.confirmedPaidInstallmentsPaise),
        formattedPending: formatINR(evaluation.pendingInstallmentsPaise),
        formattedPenalties: formatINR(evaluation.pendingPenaltiesPaise),
        isEligible: evaluation.eligibilityStatus === 'ELIGIBLE'
      }
    });
  } catch (err) {
    next(err);
  }
}

// 2. Create Death Claim
async function createDeathClaim(req, res, next) {
  try {
    const {
      memberId,
      dateOfDeath,
      nomineeId,
      nomineeName,
      nomineeRelation,
      nomineeMobile,
      nomineeAadhaar,
      nomineePan,
      remarks
    } = req.body;

    if (!memberId || !dateOfDeath) {
      return res.status(400).json({ success: false, message: 'Member ID and Date of Death are required.' });
    }

    const member = await Member.findById(memberId);
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found.' });
    }

    // Check if claim already exists
    const existingClaim = await DeathClaim.findOne({ memberId: member._id });
    if (existingClaim) {
      return res.status(400).json({
        success: false,
        message: `A death claim already exists for member ${member.memberId} (Claim ID: ${existingClaim.claimId}).`
      });
    }

    // Retrieve Nominee
    let finalNomineeName = nomineeName;
    let finalNomineeRelation = nomineeRelation;
    let finalNomineeMobile = nomineeMobile;
    let finalNomineeAadhaar = nomineeAadhaar;
    let finalNomineePan = nomineePan;

    if (nomineeId) {
      const nom = await Nominee.findById(nomineeId);
      if (nom) {
        finalNomineeName = nom.nomineeName;
        finalNomineeRelation = nom.relation;
        finalNomineeMobile = nom.mobileNumber;
        finalNomineeAadhaar = nom.aadhaarCard;
        finalNomineePan = nom.panCard;
      }
    } else if (!finalNomineeName) {
      // Find highest priority nominee
      const activeNom = await Nominee.findOne({ memberId: member._id, status: 'ACTIVE' }).sort({ priority: 1 });
      if (activeNom) {
        finalNomineeName = activeNom.nomineeName;
        finalNomineeRelation = activeNom.relation;
        finalNomineeMobile = activeNom.mobileNumber;
        finalNomineeAadhaar = activeNom.aadhaarCard;
        finalNomineePan = activeNom.panCard;
      }
    }

    if (!finalNomineeName || !finalNomineeRelation) {
      return res.status(400).json({ success: false, message: 'Nominee details are required.' });
    }

    // File path if uploaded
    const deathCertificatePath = req.file ? `/uploads/${req.file.filename}` : undefined;

    // Run eligibility calculation
    const evalData = await evaluateClaimEligibility(member._id, dateOfDeath);

    const claimId = await generateSequentialId(DeathClaim, 'claimId', 'CLM', 5);

    const claim = await DeathClaim.create({
      claimId,
      memberId: member._id,
      dateOfDeath: new Date(dateOfDeath),
      deathCertificatePath,
      nomineeId: nomineeId || undefined,
      nomineeName: finalNomineeName.trim(),
      nomineeRelation: finalNomineeRelation,
      nomineeMobile: finalNomineeMobile ? finalNomineeMobile.trim() : '',
      nomineeAadhaar: finalNomineeAadhaar ? finalNomineeAadhaar.trim() : '',
      nomineePan: finalNomineePan ? finalNomineePan.trim().toUpperCase() : '',
      registrationDate: new Date(),
      policyId: evalData.policy ? evalData.policy._id : undefined,
      totalRequiredInstallmentsPaise: evalData.totalRequiredInstallmentsPaise,
      confirmedPaidInstallmentsPaise: evalData.confirmedPaidInstallmentsPaise,
      pendingInstallmentsPaise: evalData.pendingInstallmentsPaise,
      pendingPenaltiesPaise: evalData.pendingPenaltiesPaise,
      eligibilityStatus: evalData.eligibilityStatus,
      eligibilityReason: evalData.eligibilityReason,
      claimStatus: 'PENDING_REVIEW',
      approvedAmountPaise: evalData.policy ? evalData.policy.defaultClaimAmountPaise : 0
    });

    // Update member status to DECEASED
    member.status = 'DECEASED';
    member.deathDate = new Date(dateOfDeath);
    await member.save();

    await logAuditEvent({
      req,
      action: 'DEATH_CLAIM_REGISTERED',
      entityType: 'DeathClaim',
      entityId: claim._id,
      details: {
        claimId: claim.claimId,
        memberId: member.memberId,
        eligibilityStatus: claim.eligibilityStatus,
        pendingInstallmentsINR: paiseToRupees(claim.pendingInstallmentsPaise)
      }
    });

    res.status(201).json({
      success: true,
      message: `Death claim registered successfully (Claim #${claim.claimId}). Eligibility Status: ${claim.eligibilityStatus}.`,
      claim
    });
  } catch (err) {
    next(err);
  }
}

// 3. Review Claim (Director Approval / Rejection)
async function reviewClaim(req, res, next) {
  try {
    const { id } = req.params;
    const { action, approvedAmountRupees, remarks, rejectionReason } = req.body; // action: 'APPROVE' or 'REJECT'

    if (!['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be APPROVE or REJECT.' });
    }

    const claim = await DeathClaim.findById(id).populate('memberId').populate('policyId');
    if (!claim) {
      return res.status(404).json({ success: false, message: 'Death Claim not found.' });
    }

    if (claim.claimStatus === 'APPROVED' || claim.claimStatus === 'DISBURSED') {
      return res.status(400).json({ success: false, message: 'This claim is already approved.' });
    }

    if (action === 'APPROVE') {
      // Re-verify eligibility rule: STRICTLY CANNOT APPROVE IF PENDING DUES EXIST!
      const currentEval = await evaluateClaimEligibility(claim.memberId._id, claim.dateOfDeath);
      if (currentEval.pendingInstallmentsPaise > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot approve death claim: Member ${claim.memberId.memberId} has ${formatINR(currentEval.pendingInstallmentsPaise)} in unpaid required installments under society rules. All dues must be cleared first.`
        });
      }

      // Determine approved amount
      let approvedPaise = claim.approvedAmountPaise;
      if (approvedAmountRupees !== undefined) {
        approvedPaise = rupeesToPaise(approvedAmountRupees);
      } else if (claim.policyId?.defaultClaimAmountPaise) {
        approvedPaise = claim.policyId.defaultClaimAmountPaise;
      }

      claim.claimStatus = 'APPROVED';
      claim.approvedAmountPaise = approvedPaise;
      claim.approvalDate = new Date();
      claim.approvedBy = req.director ? req.director._id : null;
      claim.approvalRemarks = remarks ? remarks.trim() : 'Approved by Director';
      claim.eligibilityStatus = 'ELIGIBLE';
      await claim.save();

      await logAuditEvent({
        req,
        action: 'DEATH_CLAIM_APPROVED',
        entityType: 'DeathClaim',
        entityId: claim._id,
        details: {
          claimId: claim.claimId,
          memberId: claim.memberId.memberId,
          approvedAmountINR: paiseToRupees(approvedPaise)
        }
      });

      res.json({
        success: true,
        message: `Death claim #${claim.claimId} approved for assistance amount of ${formatINR(approvedPaise)}. Cheque can now be prepared.`,
        claim
      });
    } else {
      // REJECT
      claim.claimStatus = 'REJECTED';
      claim.rejectionReason = rejectionReason ? rejectionReason.trim() : 'Rejected by Director';
      await claim.save();

      await logAuditEvent({
        req,
        action: 'DEATH_CLAIM_REJECTED',
        entityType: 'DeathClaim',
        entityId: claim._id,
        details: { claimId: claim.claimId, rejectionReason: claim.rejectionReason }
      });

      res.json({ success: true, message: `Death claim #${claim.claimId} has been rejected.`, claim });
    }
  } catch (err) {
    next(err);
  }
}

// 4. Get Death Claims list
async function getDeathClaims(req, res, next) {
  try {
    const { status, eligibilityStatus, search } = req.query;
    const filter = {};

    if (status) filter.claimStatus = status;
    if (eligibilityStatus) filter.eligibilityStatus = eligibilityStatus;

    const claims = await DeathClaim.find(filter)
      .populate({
        path: 'memberId',
        populate: { path: 'villageId' }
      })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = claims.map(c => ({
      ...c,
      formattedRequired: formatINR(c.totalRequiredInstallmentsPaise),
      formattedPaid: formatINR(c.confirmedPaidInstallmentsPaise),
      formattedPending: formatINR(c.pendingInstallmentsPaise),
      formattedApprovedAmount: formatINR(c.approvedAmountPaise),
      approvedAmountRupees: paiseToRupees(c.approvedAmountPaise)
    }));

    res.json({ success: true, count: formatted.length, claims: formatted });
  } catch (err) {
    next(err);
  }
}

// 5. Get Death Claim by ID
async function getDeathClaimById(req, res, next) {
  try {
    const claim = await DeathClaim.findById(req.params.id)
      .populate({
        path: 'memberId',
        populate: { path: 'villageId' }
      })
      .populate('nomineeId')
      .populate('policyId');

    if (!claim) {
      return res.status(404).json({ success: false, message: 'Death Claim not found.' });
    }

    res.json({
      success: true,
      claim: {
        ...claim.toObject(),
        formattedRequired: formatINR(claim.totalRequiredInstallmentsPaise),
        formattedPaid: formatINR(claim.confirmedPaidInstallmentsPaise),
        formattedPending: formatINR(claim.pendingInstallmentsPaise),
        formattedApprovedAmount: formatINR(claim.approvedAmountPaise),
        approvedAmountRupees: paiseToRupees(claim.approvedAmountPaise)
      }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  checkEligibility,
  createDeathClaim,
  reviewClaim,
  getDeathClaims,
  getDeathClaimById
};
