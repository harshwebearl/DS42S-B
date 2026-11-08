const ClaimEligibilityPolicy = require('../models/ClaimEligibilityPolicy');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Create Claim Policy
async function createPolicy(req, res, next) {
  try {
    const {
      policyTitle,
      effectiveDate,
      minMembershipMonths = 0,
      pendingInstallmentRule = 'STRICT_ZERO_DUES',
      penaltyEligibilityRule = 'NO_UNPAID_PENALTIES',
      claimAmountType = 'FIXED',
      defaultClaimAmountRupees,
      requiredDocuments = [],
      notes
    } = req.body;

    if (!policyTitle || defaultClaimAmountRupees === undefined) {
      return res.status(400).json({ success: false, message: 'Policy Title and Claim Amount are required.' });
    }

    const defaultClaimAmountPaise = rupeesToPaise(defaultClaimAmountRupees);
    if (defaultClaimAmountPaise <= 0) {
      return res.status(400).json({ success: false, message: 'Claim assistance amount must be greater than zero.' });
    }

    const count = await ClaimEligibilityPolicy.countDocuments();
    const policyCode = `POL-2026-V${count + 1}`;

    // Deactivate previous active policies
    await ClaimEligibilityPolicy.updateMany({}, { status: 'INACTIVE' });

    const policy = await ClaimEligibilityPolicy.create({
      policyCode,
      policyTitle: policyTitle.trim(),
      effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
      minMembershipMonths: Number(minMembershipMonths) || 0,
      pendingInstallmentRule,
      penaltyEligibilityRule,
      claimAmountType,
      defaultClaimAmountPaise,
      requiredDocuments: requiredDocuments.length > 0 ? requiredDocuments : [
        'Original Death Certificate',
        'Deceased Aadhaar Card Copy',
        'Nominee Aadhaar & PAN Card Copy',
        'Nominee Cancelled Cheque / Bank Passbook'
      ],
      notes: notes ? notes.trim() : '',
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'CLAIM_POLICY_CREATED',
      entityType: 'ClaimEligibilityPolicy',
      entityId: policy._id,
      details: { policyCode, policyTitle, amountINR: defaultClaimAmountRupees }
    });

    res.status(201).json({ success: true, message: 'Claim policy created and activated successfully', policy });
  } catch (err) {
    next(err);
  }
}

// Get all Policies
async function getPolicies(req, res, next) {
  try {
    const policies = await ClaimEligibilityPolicy.find().sort({ effectiveDate: -1 });
    const formatted = policies.map(p => ({
      ...p.toObject(),
      formattedAmount: formatINR(p.defaultClaimAmountPaise),
      amountRupees: paiseToRupees(p.defaultClaimAmountPaise)
    }));
    res.json({ success: true, count: formatted.length, policies: formatted });
  } catch (err) {
    next(err);
  }
}

// Get Active Policy
async function getActivePolicy(req, res, next) {
  try {
    let policy = await ClaimEligibilityPolicy.findOne({ status: 'ACTIVE' });
    if (!policy) {
      // Create a default standard policy if none exists
      policy = await ClaimEligibilityPolicy.create({
        policyCode: 'POL-2026-V1',
        policyTitle: 'Standard Samiti Death Claim Policy 2026',
        effectiveDate: new Date('2026-01-01'),
        minMembershipMonths: 0,
        pendingInstallmentRule: 'STRICT_ZERO_DUES',
        penaltyEligibilityRule: 'NO_UNPAID_PENALTIES',
        claimAmountType: 'FIXED',
        defaultClaimAmountPaise: 10000000, // ₹1,00,000
        requiredDocuments: [
          'Original Death Certificate',
          'Deceased Aadhaar Card Copy',
          'Nominee Aadhaar & PAN Card Copy',
          'Nominee Cancelled Cheque / Bank Passbook'
        ],
        status: 'ACTIVE'
      });
    }

    res.json({
      success: true,
      policy: {
        ...policy.toObject(),
        formattedAmount: formatINR(policy.defaultClaimAmountPaise),
        amountRupees: paiseToRupees(policy.defaultClaimAmountPaise)
      }
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPolicy,
  getPolicies,
  getActivePolicy
};
