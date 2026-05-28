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
  managed: { type: Boolean, default: false }, // true = roster record created by an agent (data, not a billable login seat)
  lastLoginAt: { type: Date },

  // Athlete fields
  sport: { type: String, default: '' },
  school: { type: String, default: '' },
  position: { type: String, default: '' },
  graduationYear: { type: Number },
  proStatus: { type: String, enum: ['collegiate', 'professional', ''], default: '' },
  nflTeam: { type: String, default: '' },
  statsUrl: { type: String, default: '' },
  cfbPlayerId: { type: String, default: '' },
  jerseyNumber: { type: Number },
  heightDisplay: { type: String, default: '' },   // e.g. "6'3\""
  weightLbs: { type: Number, default: 0 },          // e.g. 245
  fortyTime: { type: Number, default: 0 },          // e.g. 4.52
  classYear: { type: String, default: '' },         // e.g. "Junior"
  highlightUrl: { type: String, default: '' },      // YouTube/Hudl link
  draftRound: { type: String, default: '' },        // e.g. "1st - 2nd"
  draftTrend: { type: String, enum: ['up','down','steady',''], default: 'steady' },
  interestedTeams: [{ type: String }],              // e.g. ["NY Giants","Dallas Cowboys"]
  socialHandles: [socialHandleSchema],
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // agent who created/represents this athlete; null = not on any agent's list
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

  // Athlete bookmarks — opportunities saved from Discover
  savedDeals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deal' }],

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
