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

// =====================================================
// STORAGE
// =====================================================

const groups = {};

// groups[groupCode] = {
//   members: [
//     {
//       socketId,
//       userId,
//       userName,
//       lastLocation: {
//         lat,
//         lng,
//         heading
//       }
//     }
//   ],
//   tripPlan: {
//     start,
//     end,
//     routePoints,
//     stops,
//     distance,
//     duration
//   },
//   activeSOS: {
//     userId,
//     userName,
//     lat,
//     lng,
//     timestamp
//   }
// }

// =====================================================
// HELPERS
// =====================================================

function getOrCreateGroup(groupCode) {
  if (!groups[groupCode]) {
    groups[groupCode] = {
      members: [],
      tripPlan: null,
      activeSOS: null,
    };

    console.log(`GROUP CREATED: ${groupCode}`);
  }

  return groups[groupCode];
}

function emitMembers(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupMembers", {
    members: group.members.map((member) => ({
      userId: member.userId,
      userName: member.userName,
      lat: member.lastLocation?.lat ?? null,
      lng: member.lastLocation?.lng ?? null,
      heading: member.lastLocation?.heading ?? 0,
    })),
  });
}

function cleanupEmptyGroup(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  if (group.members.length === 0) {
    delete groups[groupCode];

    console.log(`GROUP DELETED: ${groupCode}`);
  }
}

// =====================================================
// SOCKET CONNECTION
// =====================================================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ===================================================
  // JOIN GROUP
  // ===================================================

  socket.on("joinGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data;

    if (!groupCode || !userId || !userName) {
      console.log("INVALID JOIN:", data);
      return;
    }

    const group = getOrCreateGroup(groupCode);

    socket.join(groupCode);

    // Remove old socket for same user
    group.members = group.members.filter(
      (member) => member.userId !== userId
    );

    const member = {
      socketId: socket.id,
      userId,
      userName,
      lastLocation: null,
    };

    group.members.push(member);

    console.log(
      `${userName} joined ${groupCode}`
    );

    console.log(
      `GROUP ${groupCode} MEMBERS:`,
      group.members.map((m) => m.userName)
    );

    // Send complete member list
    emitMembers(groupCode);

    // Notify everyone except the person who joined
    socket.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    // Send existing trip plan to newly joined rider
    if (group.tripPlan) {
      socket.emit("tripPlanReceived", group.tripPlan);
    }

    // Send current active SOS if one exists
    if (group.activeSOS) {
      socket.emit("receiveSOS", group.activeSOS);
    }

    // Send existing rider locations
    for (const existingMember of group.members) {
      if (
        existingMember.userId !== userId &&
        existingMember.lastLocation
      ) {
        socket.emit("receiveLocation", {
          groupCode,
          userId: existingMember.userId,
          userName: existingMember.userName,
          lat: existingMember.lastLocation.lat,
          lng: existingMember.lastLocation.lng,
          heading: existingMember.lastLocation.heading || 0,
        });
      }
    }

    // Inform joining user about group
    socket.emit("groupJoined", {
      groupCode,
      memberCount: group.members.length,
    });
  });

  // ===================================================
  // LEAVE GROUP
  // ===================================================

  socket.on("leaveGroup", (data) => {
    const { groupCode, userId } = data;

    const group = groups[groupCode];

    if (!group) return;

    const member = group.members.find(
      (m) => m.userId === userId
    );

    group.members = group.members.filter(
      (m) => m.userId !== userId
    );

    socket.leave(groupCode);

    if (member) {
      io.to(groupCode).emit("userLeft", {
        userId: member.userId,
        userName: member.userName,
      });
    }

    emitMembers(groupCode);

    console.log(
      `${member?.userName || userId} left ${groupCode}`
    );

    cleanupEmptyGroup(groupCode);
  });

  // ===================================================
  // LIVE LOCATION
  // ===================================================

  socket.on("sendLocation", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      heading,
    } = data;

    const group = groups[groupCode];

    if (!group) return;

    const member = group.members.find(
      (m) => m.userId === userId
    );

    if (member) {
      member.lastLocation = {
        lat,
        lng,
        heading: heading || 0,
      };
    }

    console.log(
      "SEND LOCATION:",
      userName,
      groupCode,
      lat,
      lng
    );

    socket.to(groupCode).emit(
      "receiveLocation",
      data
    );
  });

  // ===================================================
  // TRIP PLAN
  // ===================================================

  socket.on("broadcastTripPlan", (data) => {
    const {
      groupCode,
      start,
      end,
      routePoints,
      stops,
      distance,
      duration,
      leaderId,
      leaderName,
    } = data;

    const group = groups[groupCode];

    if (!group) return;

    group.tripPlan = {
      groupCode,
      start,
      end,
      routePoints: routePoints || [],
      stops: stops || [],
      distance: distance || 0,
      duration: duration || 0,
      leaderId,
      leaderName,
    };

    console.log(
      `TRIP PLAN UPDATED: ${groupCode}`
    );

    io.to(groupCode).emit(
      "tripPlanReceived",
      group.tripPlan
    );
  });

  // ===================================================
  // CLEAR TRIP PLAN
  // ===================================================

  socket.on("clearTripPlan", (data) => {
    const { groupCode } = data;

    const group = groups[groupCode];

    if (!group) return;

    group.tripPlan = null;

    io.to(groupCode).emit(
      "tripPlanCleared"
    );

    console.log(
      `TRIP PLAN CLEARED: ${groupCode}`
    );
  });

  // ===================================================
  // SOS
  // ===================================================

  socket.on("sendSOS", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      testMode,
    } = data;

    const group = groups[groupCode];

    if (!group) return;

    group.activeSOS = {
      groupCode,
      userId,
      userName,
      lat,
      lng,
      testMode: testMode === true,
      timestamp: Date.now(),
    };

    console.log(
      `SOS: ${userName} ${groupCode}`
    );

    io.to(groupCode).emit(
      "receiveSOS",
      group.activeSOS
    );
  });

  // ===================================================
  // RESOLVE SOS
  // ===================================================

  socket.on("clearSOS", (data) => {
    const { groupCode, userId } = data;

    const group = groups[groupCode];

    if (!group) return;

    if (
      group.activeSOS &&
      (
        !userId ||
        group.activeSOS.userId === userId
      )
    ) {
      const clearedSOS = group.activeSOS;

      group.activeSOS = null;

      io.to(groupCode).emit(
        "sosCleared",
        clearedSOS
      );

      console.log(
        `SOS CLEARED: ${groupCode}`
      );
    }
  });

  // ===================================================
  // DISCONNECT
  // ===================================================

  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    for (const groupCode in groups) {
      const group = groups[groupCode];

      const member = group.members.find(
        (m) => m.socketId === socket.id
      );

      if (!member) continue;

      group.members = group.members.filter(
        (m) => m.socketId !== socket.id
      );

      io.to(groupCode).emit("userLeft", {
        userId: member.userId,
        userName: member.userName,
      });

      emitMembers(groupCode);

      console.log(
        `${member.userName} disconnected from ${groupCode}`
      );

      cleanupEmptyGroup(groupCode);
    }
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Ride Tracker Backend",
    groups: Object.keys(groups).length,
    time: new Date().toISOString(),
  });
});

// =====================================================
// START
// =====================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Server running on port ${PORT}`
  );
});