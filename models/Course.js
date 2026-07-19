const mongoose = require("mongoose");

const lectureSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  link:       { type: String, default: "" },
  notes:      { type: String, default: "" },   // optional class-notes link
  order:      { type: Number, default: 0 },
  comingSoon: { type: Boolean, default: false },
  isDemo:     { type: Boolean, default: false }, // demo lectures are free without access
});

const unitSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  order:    { type: Number, default: 0 },
  lectures: [lectureSchema],
});

const chapterSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  order:      { type: Number, default: 0 },
  units:      [unitSchema],
  lectures:   [lectureSchema], // direct lectures when no units are used
  comingSoon: { type: Boolean, default: false },
});

const subjectSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  icon:     { type: String, default: "📚" },
  color:    { type: String, default: "#4f8ef7" },
  order:    { type: Number, default: 0 },
  chapters: [chapterSchema],
});

const batchSchema = new mongoose.Schema({
  name:         { type: String, required: true },
  pic:          { type: String, default: "" },         // base64 image
  description:  { type: String, default: "" },
  order:        { type: Number, default: 0 },
  isPublic:     { type: Boolean, default: false },     // private until owner publishes
  isPremium:    { type: Boolean, default: false },     // premium = referral-unlock required
  premiumUsers: { type: [String], default: [] },       // Telegram user IDs with permanent access
  price:        { type: Number, default: 0 },          // kept for schema compat (not used for payment)
  subjects:     [subjectSchema],
});

module.exports = mongoose.model("Batch", batchSchema);
