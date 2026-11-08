const ClaimCheque = require('../models/ClaimCheque');
const DeathClaim = require('../models/DeathClaim');
const Member = require('../models/Member');
const { rupeesToPaise, paiseToRupees, formatINR } = require('../utils/currency');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// 1. Issue Claim Cheque (Requires Approved Death Claim)
async function issueClaimCheque(req, res, next) {
  try {
    const {
      claimId,
      beneficiaryName,
      bankName,
      chequeNumber,
      chequeAmountRupees,
      issueDate,
      remarks
    } = req.body;

    if (!claimId || !beneficiaryName || !bankName || !chequeNumber) {
      return res.status(400).json({
        success: false,
        message: 'Claim ID, Beneficiary Name, Bank Name, and Cheque Number are required.'
      });
    }

    const claim = await DeathClaim.findById(claimId).populate('memberId');
    if (!claim) {
      return res.status(404).json({ success: false, message: 'Death Claim not found.' });
    }

    // STRICT BUSINESS RULE: Claim MUST be approved before cheque issuance!
    if (claim.claimStatus !== 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: `Claim #${claim.claimId} cannot receive a cheque because its status is "${claim.claimStatus}". Only APPROVED claims can be issued a cheque.`
      });
    }

    // STRICT BUSINESS RULE: Prevent duplicate active cheque for the same claim!
    const activeCheque = await ClaimCheque.findOne({
      claimId: claim._id,
      chequeStatus: { $in: ['PREPARED', 'ISSUED', 'HANDED_OVER', 'DEPOSITED', 'CLEARED'] }
    });

    if (activeCheque) {
      return res.status(400).json({
        success: false,
        message: `An active cheque (#${activeCheque.chequeNumber}, ID: ${activeCheque.claimChequeId}) has already been issued for this claim.`
      });
    }

    const chequeAmountPaise = chequeAmountRupees !== undefined
      ? rupeesToPaise(chequeAmountRupees)
      : claim.approvedAmountPaise;

    if (chequeAmountPaise <= 0) {
      return res.status(400).json({ success: false, message: 'Cheque amount must be greater than zero.' });
    }

    const claimChequeId = await generateSequentialId(ClaimCheque, 'claimChequeId', 'CCHQ', 5);

    const cheque = await ClaimCheque.create({
      claimChequeId,
      claimId: claim._id,
      memberId: claim.memberId._id,
      beneficiaryName: beneficiaryName.trim(),
      chequeAmountPaise,
      bankName: bankName.trim(),
      chequeNumber: chequeNumber.trim(),
      issueDate: issueDate ? new Date(issueDate) : new Date(),
      chequeStatus: 'ISSUED',
      remarks: remarks ? remarks.trim() : ''
    });

    await logAuditEvent({
      req,
      action: 'CLAIM_CHEQUE_ISSUED',
      entityType: 'ClaimCheque',
      entityId: cheque._id,
      details: {
        claimChequeId: cheque.claimChequeId,
        claimId: claim.claimId,
        chequeNumber: cheque.chequeNumber,
        amountINR: paiseToRupees(chequeAmountPaise),
        beneficiaryName: cheque.beneficiaryName
      }
    });

    res.status(201).json({
      success: true,
      message: `Claim Cheque #${cheque.chequeNumber} for ${formatINR(chequeAmountPaise)} prepared and issued successfully.`,
      cheque: {
        ...cheque.toObject(),
        formattedAmount: formatINR(cheque.chequeAmountPaise),
        amountRupees: paiseToRupees(cheque.chequeAmountPaise)
      }
    });
  } catch (err) {
    next(err);
  }
}

// 2. Record Cheque Handover
async function recordHandover(req, res, next) {
  try {
    const { id } = req.params;
    const { handoverDate, handoverRecipientName, handoverRecipientPhone, remarks } = req.body;

    const cheque = await ClaimCheque.findById(id).populate('claimId');
    if (!cheque) {
      return res.status(404).json({ success: false, message: 'Claim Cheque not found.' });
    }

    cheque.handoverDate = handoverDate ? new Date(handoverDate) : new Date();
    cheque.handoverRecipientName = handoverRecipientName ? handoverRecipientName.trim() : cheque.beneficiaryName;
    cheque.handoverRecipientPhone = handoverRecipientPhone ? handoverRecipientPhone.trim() : '';
    cheque.chequeStatus = 'HANDED_OVER';
    if (remarks) cheque.remarks = remarks.trim();

    if (req.file) {
      cheque.handoverAckDocumentPath = `/uploads/${req.file.filename}`;
    }

    await cheque.save();

    await logAuditEvent({
      req,
      action: 'CLAIM_CHEQUE_HANDOVER',
      entityType: 'ClaimCheque',
      entityId: cheque._id,
      details: {
        claimChequeId: cheque.claimChequeId,
        recipient: cheque.handoverRecipientName,
        handoverDate: cheque.handoverDate
      }
    });

    res.json({
      success: true,
      message: `Cheque #${cheque.chequeNumber} marked as HANDED OVER to ${cheque.handoverRecipientName}.`,
      cheque
    });
  } catch (err) {
    next(err);
  }
}

// 3. Update Claim Cheque Status (Deposited, Cleared, Returned, Cancelled)
async function updateClaimChequeStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, clearanceDate, remarks } = req.body;

    if (!['PREPARED', 'ISSUED', 'HANDED_OVER', 'DEPOSITED', 'CLEARED', 'RETURNED', 'CANCELLED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid claim cheque status.' });
    }

    const cheque = await ClaimCheque.findById(id).populate('claimId');
    if (!cheque) {
      return res.status(404).json({ success: false, message: 'Claim Cheque not found.' });
    }

    cheque.chequeStatus = status;
    if (remarks) cheque.remarks = remarks.trim();

    if (status === 'CLEARED') {
      cheque.clearanceDate = clearanceDate ? new Date(clearanceDate) : new Date();

      // Mark the parent DeathClaim as DISBURSED!
      if (cheque.claimId) {
        cheque.claimId.claimStatus = 'DISBURSED';
        await cheque.claimId.save();
      }
    }

    await cheque.save();

    await logAuditEvent({
      req,
      action: `CLAIM_CHEQUE_${status}`,
      entityType: 'ClaimCheque',
      entityId: cheque._id,
      details: { claimChequeId: cheque.claimChequeId, newStatus: status }
    });

    res.json({
      success: true,
      message: `Claim Cheque status updated to ${status}.`,
      cheque
    });
  } catch (err) {
    next(err);
  }
}

// 4. Get all Claim Cheques
async function getClaimCheques(req, res, next) {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status) filter.chequeStatus = status;

    const cheques = await ClaimCheque.find(filter)
      .populate('claimId')
      .populate({
        path: 'memberId',
        populate: { path: 'villageId' }
      })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = cheques.map(c => ({
      ...c,
      formattedAmount: formatINR(c.chequeAmountPaise),
      amountRupees: paiseToRupees(c.chequeAmountPaise)
    }));

    res.json({ success: true, count: formatted.length, cheques: formatted });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  issueClaimCheque,
  recordHandover,
  updateClaimChequeStatus,
  getClaimCheques
};
