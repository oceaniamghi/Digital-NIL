import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const socialHandleSchema = new mongoose.Schema({
  platform: { type: String, enum: ['twitter', 'instagram', 'tiktok', 'youtube', 'facebook'] },
  handle: String,
  followers: { type: Number, default: 0 },
  connected: { type: Boolean, default: false }
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: ['athlete', 'brand', 'agent'], default: 'athlete' },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '', maxlength: 500 },
  verified: { type: Boolean, default: false },

  // Athlete fields
  sport: { type: String, default: '' },
  school: { type: String, default: '' },
  position: { type: String, default: '' },
  graduationYear: { type: Number },
  proStatus: { type: String, enum: ['collegiate', 'professional', ''], default: '' },
  nflTeam: { type: String, default: '' },
  statsUrl: { type: String, default: '' },
  cfbPlayerId: { type: String, default: '' },
  socialHandles: [socialHandleSchema],
  nilValue: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  dealsCompleted: { type: Number, default: 0 },

  // Brand fields
  company: { type: String, default: '' },
  industry: { type: String, default: '' },
  website: { type: String, default: '' },
  logo: { type: String, default: '' },

  // Agent fields
  agency: { type: String, default: '' },
  athletes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

export default mongoose.model('User', userSchema);
