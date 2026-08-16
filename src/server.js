const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// ============================================================
// GROUP STORAGE
// ============================================================

const groups = {};

// ============================================================
// GROUP HELPER
// ============================================================

function getGroup(groupCode) {
  if (!groups[groupCode]) {
    groups[groupCode] = {
      members: [],
      leaderId: null,
      tripPlan: null,
      activeSOS: null,
    };
  }

  return groups[groupCode];
}

// ============================================================
// FIND MEMBER
// ============================================================

function findMember(group, userId) {
  return group.members.find(
    (member) => member.userId === userId
  );
}

// ============================================================
// BUILD PUBLIC MEMBERS
// ============================================================

function getPublicMembers(group) {
  return group.members.map((member) => ({
    userId: member.userId,
    userName: member.userName,
    lat: member.lat,
    lng: member.lng,
    heading: member.heading,
    isLeader: member.userId === group.leaderId,
  }));
}

// ============================================================
// SOCKET
// ============================================================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ==========================================================
  // JOIN GROUP
  // ==========================================================

  socket.on("joinGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data || {};

    if (!groupCode || !userId || !userName) {
      console.log("Invalid joinGroup request");
      return;
    }

    const group = getGroup(groupCode);

    socket.join(groupCode);

    // --------------------------------------------------------
    // Check if this user already exists
    // --------------------------------------------------------

    const existing = findMember(group, userId);

    if (existing) {
      existing.socketId = socket.id;
      existing.userName = userName;
    } else {
      group.members.push({
        socketId: socket.id,
        userId,
        userName,
        lat: null,
        lng: null,
        heading: 0,
      });
    }

    // --------------------------------------------------------
    // FIRST MEMBER BECOMES LEADER
    // --------------------------------------------------------

    if (!group.leaderId) {
      group.leaderId = userId;

      console.log(
        `${userName} is now LEADER of ${groupCode}`
      );
    }

    // --------------------------------------------------------
    // Public members
    // --------------------------------------------------------

    const publicMembers = getPublicMembers(group);

    console.log(
      `${userName} joined ${groupCode} | Leader: ${group.leaderId}`
    );

    // --------------------------------------------------------
    // Send members to everyone
    // --------------------------------------------------------

    io.to(groupCode).emit("groupMembers", {
      members: publicMembers,
      leaderId: group.leaderId,
    });

    // --------------------------------------------------------
    // Notify everyone
    // --------------------------------------------------------

    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
      isLeader: userId === group.leaderId,
    });

    // --------------------------------------------------------
    // Tell the joining user who the leader is
    // --------------------------------------------------------

    socket.emit("leaderChanged", {
      leaderId: group.leaderId,
    });

    // --------------------------------------------------------
    // SEND EXISTING TRIP PLAN TO LATE JOINER
    // --------------------------------------------------------

    if (group.tripPlan) {
      socket.emit(
        "tripPlanUpdated",
        group.tripPlan
      );

      console.log(
        `Sent existing trip plan to ${userName}`
      );
    }

    // --------------------------------------------------------
    // SEND ACTIVE SOS TO LATE JOINER
    // --------------------------------------------------------

    if (group.activeSOS) {
      socket.emit(
        "receiveSOS",
        group.activeSOS
      );
    }
  });

  // ==========================================================
  // LIVE LOCATION
  // ==========================================================

  socket.on("sendLocation", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      heading,
    } = data || {};

    if (
      !groupCode ||
      !userId ||
      typeof lat !== "number" ||
      typeof lng !== "number"
    ) {
      return;
    }

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    const member = findMember(group, userId);

    if (!member) {
      return;
    }

    member.lat = lat;
    member.lng = lng;
    member.heading =
      typeof heading === "number"
        ? heading
        : 0;

    socket.to(groupCode).emit(
      "receiveLocation",
      {
        groupCode,
        userId,
        userName,
        lat,
        lng,
        heading: member.heading,
      }
    );

    console.log(
      "SEND LOCATION:",
      userName,
      groupCode,
      lat,
      lng
    );
  });

  // ==========================================================
  // BROADCAST TRIP PLAN
  // ONLY LEADER CAN CHANGE IT
  // ==========================================================

  socket.on("broadcastTripPlan", (data) => {
    const {
      groupCode,
      userId,
      start,
      end,
      routePoints,
      distance,
      duration,
      stops,
      selectedRouteIndex,
      alternatives,
    } = data || {};

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    // --------------------------------------------------------
    // LEADER CHECK
    // --------------------------------------------------------

    if (group.leaderId !== userId) {
      socket.emit("tripPlanError", {
        message:
          "Only the group leader can change the trip plan.",
      });

      return;
    }

    group.tripPlan = {
      start: start || null,
      end: end || null,

      routePoints:
        Array.isArray(routePoints)
          ? routePoints
          : [],

      distance:
        typeof distance === "number"
          ? distance
          : 0,

      duration:
        typeof duration === "number"
          ? duration
          : 0,

      stops:
        Array.isArray(stops)
          ? stops
          : [],

      selectedRouteIndex:
        typeof selectedRouteIndex === "number"
          ? selectedRouteIndex
          : 0,

      alternatives:
        Array.isArray(alternatives)
          ? alternatives
          : [],

      leaderId: group.leaderId,

      updatedAt: Date.now(),
    };

    console.log(
      `TRIP PLAN UPDATED by leader: ${groupCode}`
    );

    io.to(groupCode).emit(
      "tripPlanUpdated",
      group.tripPlan
    );
  });

  // ==========================================================
  // CLEAR TRIP PLAN
  // ONLY LEADER
  // ==========================================================

  socket.on("clearTripPlan", (data) => {
    const {
      groupCode,
      userId,
    } = data || {};

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    if (group.leaderId !== userId) {
      socket.emit("tripPlanError", {
        message:
          "Only the group leader can clear the trip plan.",
      });

      return;
    }

    group.tripPlan = null;

    console.log(
      `TRIP PLAN CLEARED: ${groupCode}`
    );

    io.to(groupCode).emit(
      "tripPlanCleared"
    );
  });

  // ==========================================================
  // SOS
  // ==========================================================

  socket.on("sendSOS", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
    } = data || {};

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    group.activeSOS = {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      timestamp: Date.now(),
    };

    console.log(
      "SOS:",
      userName,
      groupCode,
      lat,
      lng
    );

    io.to(groupCode).emit(
      "receiveSOS",
      group.activeSOS
    );
  });

  // ==========================================================
  // CLEAR SOS
  // ==========================================================

  socket.on("clearSOS", (data) => {
    const {
      groupCode,
      userId,
    } = data || {};

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    if (
      group.activeSOS &&
      group.activeSOS.userId === userId
    ) {
      group.activeSOS = null;
    }

    io.to(groupCode).emit(
      "sosCleared",
      {
        userId,
      }
    );
  });

  // ==========================================================
  // LEAVE GROUP
  // ==========================================================

  socket.on("leaveGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data || {};

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    const leavingUser = findMember(
      group,
      userId
    );

    if (!leavingUser) {
      return;
    }

    const wasLeader =
      group.leaderId === userId;

    group.members =
      group.members.filter(
        (member) =>
          member.userId !== userId
      );

    socket.leave(groupCode);

    // --------------------------------------------------------
    // Leader leaves
    // Give leadership to next member
    // --------------------------------------------------------

    if (
      wasLeader &&
      group.members.length > 0
    ) {
      group.leaderId =
        group.members[0].userId;

      const newLeader =
        group.members[0];

      console.log(
        `${newLeader.userName} is now LEADER of ${groupCode}`
      );

      io.to(groupCode).emit(
        "leaderChanged",
        {
          leaderId:
            group.leaderId,
        }
      );
    }

    // --------------------------------------------------------
    // Nobody left
    // Delete empty group
    // --------------------------------------------------------

    if (group.members.length === 0) {
      delete groups[groupCode];

      console.log(
        `Deleted empty group ${groupCode}`
      );

      return;
    }

    // --------------------------------------------------------
    // Update members
    // --------------------------------------------------------

    io.to(groupCode).emit(
      "groupMembers",
      {
        members:
          getPublicMembers(group),

        leaderId:
          group.leaderId,
      }
    );

    io.to(groupCode).emit(
      "userLeft",
      {
        userId,
        userName,
      }
    );

    console.log(
      `${userName} left ${groupCode}`
    );
  });

  // ==========================================================
  // DISCONNECT
  // ==========================================================

  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    for (const groupCode in groups) {
      const group =
        groups[groupCode];

      const user =
        group.members.find(
          (member) =>
            member.socketId ===
            socket.id
        );

      if (!user) {
        continue;
      }

      const wasLeader =
        group.leaderId ===
        user.userId;

      group.members =
        group.members.filter(
          (member) =>
            member.socketId !==
            socket.id
        );

      // ------------------------------------------------------
      // Assign new leader
      // ------------------------------------------------------

      if (
        wasLeader &&
        group.members.length > 0
      ) {
        group.leaderId =
          group.members[0].userId;

        console.log(
          `${group.members[0].userName} became leader`
        );

        io.to(groupCode).emit(
          "leaderChanged",
          {
            leaderId:
              group.leaderId,
          }
        );
      }

      // ------------------------------------------------------
      // Empty group
      // ------------------------------------------------------

      if (
        group.members.length === 0
      ) {
        delete groups[groupCode];

        console.log(
          `Deleted empty group ${groupCode}`
        );

        continue;
      }

      // ------------------------------------------------------
      // Update members
      // ------------------------------------------------------

      io.to(groupCode).emit(
        "groupMembers",
        {
          members:
            getPublicMembers(group),

          leaderId:
            group.leaderId,
        }
      );

      io.to(groupCode).emit(
        "userLeft",
        {
          userId:
            user.userId,

          userName:
            user.userName,
        }
      );

      console.log(
        `${user.userName} disconnected from ${groupCode}`
      );
    }
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Ride Tracker Backend",
    groups: Object.keys(groups).length,
  });
});

// ============================================================
// START
// ============================================================

server.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});