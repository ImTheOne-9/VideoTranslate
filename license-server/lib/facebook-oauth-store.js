function createFacebookOAuthStore(mongoose) {
  const schema = new mongoose.Schema({
    _id: String, owner: { type: String, index: true }, challenge: String,
    state: String, browserHash: String, status: String,
    encryptedPages: String, error: String,
    expiresAt: { type: Date, required: true }, createdAt: Date
  }, { versionKey: false });
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  schema.index({ state: 1 }, { unique: true });
  const model = mongoose.models.FacebookOAuthSession || mongoose.model('FacebookOAuthSession', schema);
  return {
    ready: () => mongoose.connection.readyState === 1,
    count: (owner, now) => model.countDocuments({ owner, expiresAt: { $gt: new Date(now) }, status: { $nin: ['consumed', 'error'] } }),
    create: (session) => model.create(session),
    get: (id, now) => model.findOne({ _id: id, expiresAt: { $gt: new Date(now) } }).lean(),
    transition: (filter, changes, now) => model.findOneAndUpdate(
      { ...filter, expiresAt: { $gt: new Date(now) } }, { $set: changes }, { new: true }
    ).lean()
  };
}

module.exports = { createFacebookOAuthStore };
