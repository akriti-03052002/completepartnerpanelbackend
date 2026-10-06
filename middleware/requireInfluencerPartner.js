const requireInfluencerPartner = (req, res, next) => {
  if (req.partner.partnerType !== "influencer") {
    return res.status(403).json({
      success: false,
      message: "This feature is only available to Influencer partners."
    });
  }

  next();
};

module.exports = requireInfluencerPartner;
