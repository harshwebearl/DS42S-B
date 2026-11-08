const FinancialYear = require('../models/FinancialYear');
const InstallmentMaster = require('../models/InstallmentMaster');
const { generateSequentialId } = require('../utils/idGenerator');
const { logAuditEvent } = require('../middleware/audit');

// Create Financial Year with non-overlap validation
async function createFinancialYear(req, res, next) {
  try {
    const { yearName, startDate, endDate, isCurrent, description } = req.body;
    if (!yearName || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'Year Name, Start Date, and End Date are required.' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start >= end) {
      return res.status(400).json({ success: false, message: 'Start Date must be before End Date.' });
    }

    // Check overlapping financial years
    const overlap = await FinancialYear.findOne({
      $or: [
        { startDate: { $lte: end }, endDate: { $gte: start } }
      ]
    });

    if (overlap) {
      return res.status(400).json({
        success: false,
        message: `Date range overlaps with existing Financial Year "${overlap.yearName}" (${new Date(overlap.startDate).toLocaleDateString()} to ${new Date(overlap.endDate).toLocaleDateString()}).`
      });
    }

    const fyCode = `FY-${yearName.trim()}`;

    // If marked current, unset other current FYs
    if (isCurrent) {
      await FinancialYear.updateMany({}, { isCurrent: false });
    }

    const fy = await FinancialYear.create({
      fyCode,
      yearName: yearName.trim(),
      startDate: start,
      endDate: end,
      isCurrent: !!isCurrent,
      description: description ? description.trim() : '',
      status: 'ACTIVE'
    });

    await logAuditEvent({
      req,
      action: 'FINANCIAL_YEAR_CREATED',
      entityType: 'FinancialYear',
      entityId: fy._id,
      details: { fyCode, yearName }
    });

    res.status(201).json({ success: true, message: 'Financial Year created successfully', financialYear: fy });
  } catch (err) {
    next(err);
  }
}

// Get all Financial Years with installment count
async function getFinancialYears(req, res, next) {
  try {
    const years = await FinancialYear.find().sort({ startDate: -1 }).lean();

    const installmentCounts = await InstallmentMaster.aggregate([
      { $group: { _id: '$financialYearId', count: { $sum: 1 } } }
    ]);

    const countMap = {};
    installmentCounts.forEach(c => {
      countMap[String(c._id)] = c.count;
    });

    const enrichedYears = years.map(y => ({
      ...y,
      installmentCount: countMap[String(y._id)] || 0
    }));

    res.json({ success: true, count: enrichedYears.length, financialYears: enrichedYears });
  } catch (err) {
    next(err);
  }
}

// Update Financial Year
async function updateFinancialYear(req, res, next) {
  try {
    const { yearName, startDate, endDate, isCurrent, status, description } = req.body;
    const fy = await FinancialYear.findById(req.params.id);
    if (!fy) {
      return res.status(404).json({ success: false, message: 'Financial Year not found.' });
    }

    const start = startDate ? new Date(startDate) : fy.startDate;
    const end = endDate ? new Date(endDate) : fy.endDate;
    if (start >= end) {
      return res.status(400).json({ success: false, message: 'Start Date must be before End Date.' });
    }

    // Check overlap with other financial years
    const overlap = await FinancialYear.findOne({
      _id: { $ne: fy._id },
      $or: [
        { startDate: { $lte: end }, endDate: { $gte: start } }
      ]
    });
    if (overlap) {
      return res.status(400).json({
        success: false,
        message: `Date range overlaps with existing Financial Year "${overlap.yearName}".`
      });
    }

    if (yearName) fy.yearName = yearName.trim();
    fy.startDate = start;
    fy.endDate = end;
    if (status) fy.status = status;
    if (description !== undefined) fy.description = description.trim();

    if (isCurrent) {
      await FinancialYear.updateMany({ _id: { $ne: fy._id } }, { isCurrent: false });
      fy.isCurrent = true;
    } else if (isCurrent === false) {
      fy.isCurrent = false;
    }

    await fy.save();

    await logAuditEvent({
      req,
      action: 'FINANCIAL_YEAR_UPDATED',
      entityType: 'FinancialYear',
      entityId: fy._id,
      details: { yearName: fy.yearName, status: fy.status }
    });

    res.json({ success: true, message: 'Financial Year updated successfully', financialYear: fy });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createFinancialYear,
  getFinancialYears,
  updateFinancialYear
};
