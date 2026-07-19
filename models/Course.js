"use strict";
/**
 * models/Course.js — StuBot Batch/Course Schema
 * ─────────────────────────────────────────────
 * Hierarchy: Batch → Subjects → Chapters → Units (optional) → Lectures
 *
 * NOTE: Linux filesystem is case-sensitive. routes/course.js requires
 * this file as  require('../models/Course')  — capital C — so the
 * filename MUST be  Course.js  (capital C).
 */

const mongoose = require("mongoose");

// ── Lecture ───────────────────────────────────────────────────────────────────
const lectureSchema = new mongoose.Schema({
  name:    { type: String, required: true },
  link:    { type: String, default: "" },   // video / resource URL
  notes:   { type: String, default: "" },   // PDF / notes URL
  order:   { type: Number, default: 0 },
  isDemo:  { type: Boolean, default: false }, // public preview lecture
  addedAt: { type: Date,   default: Date.now },
});

// ── Unit (optional grouping inside a Chapter) ─────────────────────────────────
const unitSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  order:    { type: Number, default: 0 },
  lectures: { type: [lectureSchema], default: [] },
});

// ── Chapter ───────────────────────────────────────────────────────────────────
const chapterSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  order:    { type: Number, default: 0 },
  lectures: { type: [lectureSchema], default: [] },
  units:    { type: [unitSchema],    default: [] },
});

// ── Subject ───────────────────────────────────────────────────────────────────
const subjectSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  order:    { type: Number, default: 0 },
  chapters: { type: [chapterSchema], default: [] },
});

// ── Batch (top-level document) ────────────────────────────────────────────────
const batchSchema = new mongoose.Schema(
  {
    name:         { type: String,  required: true },
    description:  { type: String,  default: "" },
    pic:          { type: String,  default: "" },   // cover image URL
    isPremium:    { type: Boolean, default: false },
    isPublic:     { type: Boolean, default: true  },
    order:        { type: Number,  default: 0 },
    premiumUsers: { type: [String], default: [] },  // userId strings with permanent access
    subjects:     { type: [subjectSchema], default: [] },
  },
  { timestamps: true }
);

// Indexes
batchSchema.index({ order: 1 });
batchSchema.index({ isPublic: 1 });

const Batch = mongoose.models.Batch || mongoose.model("Batch", batchSchema);

module.exports = Batch;
