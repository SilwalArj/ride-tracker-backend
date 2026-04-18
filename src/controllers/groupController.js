const Group = require("../models/Group");
const generateCode = require("../utils/generateCode");

exports.createGroup = async (req, res) => {
  try {
    const { groupName, userId } = req.body;

    const code = generateCode();

    const group = new Group({
      groupName,
      leader: userId,
      members: [userId],
      groupCode: code
    });

    await group.save();

    res.json(group);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.joinGroup = async (req, res) => {
  try {
    const { groupCode, userId } = req.body;

    const group = await Group.findOne({ groupCode });

    if (!group) {
      return res.status(404).json({ msg: "Group not found" });
    }

    if (!group.members.includes(userId)) {
      group.members.push(userId);
      await group.save();
    }

    res.json(group);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};