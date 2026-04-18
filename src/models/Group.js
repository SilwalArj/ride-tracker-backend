const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema({
  groupName: {
    type: String,
    required: true
  },
  leader: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  members: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  ],
  groupCode: {
    type: String,
    unique: true
  }
}, { timestamps: true });

module.exports = mongoose.model("Group", groupSchema);