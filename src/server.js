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

const PORT = process.env.PORT || 5000;

// ======================================================
// GROUP STORAGE
// ======================================================
//
// groups = {
//   ABC123: {
//     leaderUserId: "...",
//     members: [
//       {
//         socketId,
//         userId,
//         userName,
//         groupType,
//         lat,
//         lng,
//         heading,
//         lastSeen
//       }
//     ],
//     tripPlan: {
//       plannedByUserId,
//       plannedByUserName,
//       groupType,
//       startPlace,
//       endPlace,
//       start,
//       destination,
//       routePoints,
//       updatedAt
//     }
//   }
// }

const groups = {};

// ======================================================
// HELPERS
// ======================================================

function getOrCreateGroup(groupCode) {
  if (!groups[groupCode]) {
    groups[groupCode] = {
      leaderUserId: null,
      members: [],
      tripPlan: null,
    };
  }

  return groups[groupCode];
}

function getPublicMembers(group) {
  return group.members.map((member) => ({
    userId: member.userId,
    userName: member.userName,
    groupType: member.groupType,
    lat: member.lat,
    lng: member.lng,
    heading: member.heading,
    lastSeen: member.lastSeen,
  }));
}

function broadcastGroupInfo(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupInfo", {
    groupCode,
    leaderUserId: group.leaderUserId,
  });
}

function broadcastMembers(groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  io.to(groupCode).emit("groupMembers", {
    members: getPublicMembers(group),
  });
}

function broadcastLocationsToSocket(socket, groupCode) {
  const group = groups[groupCode];

  if (!group) return;

  const locations = group.members
    .filter(
      (member) =>
        member.lat !== null &&
        member.lng !== null
    )
    .map((member) => ({
      userId: member.userId,
      userName: member.userName,
      groupType: member.groupType,
      lat: member.lat,
      lng: member.lng,
      heading: member.heading ?? 0,
      lastSeen: member.lastSeen,
    }));

  socket.emit("groupLocations", {
    locations,
  });
}

function removeSocketFromGroup(socket, groupCode) {
  const group = groups[groupCode];

  if (!group) return null;

  const index = group.members.findIndex(
    (member) => member.socketId === socket.id
  );

  if (index === -1) {
    return null;
  }

  const removedUser = group.members[index];

  group.members.splice(index, 1);

  // If the leader leaves, elect the first remaining member.
  if (
    removedUser.userId === group.leaderUserId
  ) {
    group.leaderUserId =
      group.members.length > 0
        ? group.members[0].userId
        : null;
  }

  socket.leave(groupCode);

  broadcastMembers(groupCode);
  broadcastGroupInfo(groupCode);

  io.to(groupCode).emit("userLeft", {
    userId: removedUser.userId,
    userName: removedUser.userName,
  });

  console.log(
    `${removedUser.userName} left ${groupCode}`
  );

  // Delete empty group
  if (group.members.length === 0) {
    delete groups[groupCode];

    console.log(
      `Group ${groupCode} removed`
    );
  }

  return removedUser;
}

// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on("connection", (socket) => {
  console.log(
    "User connected:",
    socket.id
  );

  // ====================================================
  // JOIN GROUP
  // ====================================================

  socket.on("joinGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
      groupType,
    } = data;

    if (
      !groupCode ||
      !userId ||
      !userName
    ) {
      console.log(
        "Invalid joinGroup data:",
        data
      );
      return;
    }

    const group =
      getOrCreateGroup(groupCode);

    // First user becomes leader.
    if (!group.leaderUserId) {
      group.leaderUserId = userId;
    }

    socket.join(groupCode);

    socket.data.groupCode = groupCode;
    socket.data.userId = userId;

    // Remove duplicate user if same user reconnects.
    group.members =
      group.members.filter(
        (member) =>
          member.userId !== userId
      );

    group.members.push({
      socketId: socket.id,
      userId,
      userName,
      groupType: groupType ?? "unknown",

      // We don't know location immediately.
      lat: null,
      lng: null,
      heading: 0,
      lastSeen: null,
    });

    const isLeader =
      group.leaderUserId === userId;

    console.log(
      `${userName} joined ${groupCode}`
    );

    console.log(
      "Leader:",
      group.leaderUserId
    );

    // Send group information to joining user.
    socket.emit("groupInfo", {
      groupCode,
      leaderUserId:
        group.leaderUserId,
      isLeader,
    });

    // Tell joining user that group is ready.
    socket.emit("groupCreated", {
      groupCode,
    });

    // Update everyone with members.
    broadcastMembers(groupCode);

    // Notify EVERYONE EXCEPT joining user.
    socket.to(groupCode).emit(
      "userJoined",
      {
        userId,
        userName,
      }
    );

    // Give the new rider the latest locations
    // of everyone already in the group.
    broadcastLocationsToSocket(
      socket,
      groupCode
    );

    // Give the new rider the current shared trip plan.
    if (group.tripPlan) {
      socket.emit(
        "tripPlanUpdated",
        group.tripPlan
      );
    }
  });

  // ====================================================
  // LIVE LOCATION
  // ====================================================

  socket.on("sendLocation", (data) => {
    const {
      groupCode,
      userId,
      userName,
      groupType,
      lat,
      lng,
      heading,
    } = data;

    if (
      !groupCode ||
      !userId ||
      lat === undefined ||
      lng === undefined
    ) {
      return;
    }

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    const member =
      group.members.find(
        (user) =>
          user.userId === userId
      );

    if (member) {
      member.lat = lat;
      member.lng = lng;
      member.heading =
        typeof heading === "number"
          ? heading
          : 0;

      member.lastSeen =
        new Date().toISOString();

      if (groupType) {
        member.groupType =
          groupType;
      }
    }

    console.log(
      "SEND LOCATION:",
      userName,
      groupCode,
      lat,
      lng,
      heading
    );

    // Send to everyone in room.
    // Flutter ignores its own userId.
    io.to(groupCode).emit(
      "receiveLocation",
      {
        groupCode,
        userId,
        userName,
        groupType,
        lat,
        lng,
        heading:
          typeof heading === "number"
            ? heading
            : 0,
        lastSeen:
          member?.lastSeen ?? null,
      }
    );
  });

  // ====================================================
  // SET SHARED TRIP PLAN
  // ====================================================

  socket.on("setTripPlan", (data) => {
    const {
      groupCode,
      userId,
      userName,
      groupType,
      startPlace,
      endPlace,
      start,
      destination,
      routePoints,
    } = data;

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    // Only leader can change shared route.
    if (
      group.leaderUserId !== userId
    ) {
      socket.emit(
        "tripPlanError",
        {
          message:
            "Only the group leader can set the shared route.",
        }
      );

      return;
    }

    group.tripPlan = {
      plannedByUserId: userId,
      plannedByUserName: userName,

      groupType:
        groupType ?? "unknown",

      startPlace:
        startPlace ?? "",

      endPlace:
        endPlace ?? "",

      start:
        start ?? null,

      destination:
        destination ?? null,

      routePoints:
        Array.isArray(routePoints)
          ? routePoints
          : [],

      updatedAt:
        new Date().toISOString(),
    };

    console.log(
      `Trip plan updated in ${groupCode}`
    );

    console.log(
      "Planner:",
      userName
    );

    console.log(
      "Destination:",
      endPlace
    );

    console.log(
      "Route points:",
      group.tripPlan.routePoints.length
    );

    // Everyone gets the same destination + route.
    io.to(groupCode).emit(
      "tripPlanUpdated",
      group.tripPlan
    );
  });

  // ====================================================
  // CLEAR SHARED TRIP PLAN
  // ====================================================

  socket.on("clearTripPlan", (data) => {
    const {
      groupCode,
      userId,
    } = data;

    const group = groups[groupCode];

    if (!group) {
      return;
    }

    if (
      group.leaderUserId !== userId
    ) {
      return;
    }

    group.tripPlan = null;

    io.to(groupCode).emit(
      "tripPlanCleared"
    );

    console.log(
      `Trip plan cleared for ${groupCode}`
    );
  });

  // ====================================================
  // SOS
  // ====================================================

  socket.on("sendSOS", (data) => {
    const {
      groupCode,
      userId,
      userName,
      lat,
      lng,
    } = data;

    console.log(
      `SOS from ${userName} in ${groupCode}`
    );

    // Everyone in the group receives it.
    io.to(groupCode).emit(
      "receiveSOS",
      {
        groupCode,
        userId,
        userName,
        lat,
        lng,
      }
    );
  });

  // ====================================================
  // EXPLICIT LEAVE
  // ====================================================

  socket.on("leaveGroup", (data) => {
    const {
      groupCode,
    } = data;

    if (!groupCode) {
      return;
    }

    removeSocketFromGroup(
      socket,
      groupCode
    );
  });

  // ====================================================
  // DISCONNECT
  // ====================================================

  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    const groupCode =
      socket.data.groupCode;

    if (!groupCode) {
      return;
    }

    removeSocketFromGroup(
      socket,
      groupCode
    );
  });
});

// ======================================================
// TEST ROUTE
// ======================================================

app.get("/", (req, res) => {
  res.send(
    "Ride Tracker Backend Running"
  );
});

// ======================================================
// START SERVER
// ======================================================

server.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});