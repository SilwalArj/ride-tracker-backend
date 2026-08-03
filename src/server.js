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
//     members: [
//       {
//         socketId,
//         userId,
//         userName
//       }
//     ],
//
//     tripPlan: {
//       plannedByUserId,
//       plannedByUserName,
//       startPlace,
//       endPlace,
//       start: { lat, lng },
//       destination: { lat, lng },
//       routePoints: [
//         { lat, lng },
//         ...
//       ],
//       groupType,
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
      members: [],
      tripPlan: null,
    };
  }

  return groups[groupCode];
}

// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // ====================================================
  // JOIN GROUP
  // ====================================================

  socket.on("joinGroup", (data) => {
    const {
      groupCode,
      userId,
      userName,
    } = data;

    if (!groupCode || !userId || !userName) {
      console.log("Invalid joinGroup data:", data);
      return;
    }

    const group = getOrCreateGroup(groupCode);

    socket.join(groupCode);

    // Remove duplicate user entry
    group.members = group.members.filter(
      (user) => user.userId !== userId
    );

    // Add current user
    group.members.push({
      socketId: socket.id,
      userId,
      userName,
    });

    console.log(`${userName} joined ${groupCode}`);

    // Send complete member list
    io.to(groupCode).emit("groupMembers", {
      members: group.members,
    });

    // Tell everyone that a user joined
    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    // Tell the joining user about the group
    socket.emit("groupCreated", {
      groupCode,
    });

    // IMPORTANT:
    // If a trip plan already exists,
    // immediately send it to the newly joined user.
    if (group.tripPlan) {
      socket.emit("tripPlanUpdated", group.tripPlan);
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
      lat,
      lng,
    } = data;

    if (!groupCode || !userId) {
      return;
    }

    console.log(
      "SEND LOCATION:",
      userName,
      groupCode,
      lat,
      lng
    );

    // Broadcast to everyone else in this group
    socket.to(groupCode).emit(
      "receiveLocation",
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
  // TRIP PLAN / DESTINATION
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

    if (!groupCode) {
      return;
    }

    const group = getOrCreateGroup(groupCode);

    group.tripPlan = {
      plannedByUserId: userId,
      plannedByUserName: userName,

      groupType: groupType ?? "unknown",

      startPlace: startPlace ?? "",
      endPlace: endPlace ?? "",

      start: start ?? null,
      destination: destination ?? null,

      routePoints: Array.isArray(routePoints)
          ? routePoints
          : [],

      updatedAt: new Date().toISOString(),
    };

    console.log(
      `Trip plan updated in ${groupCode} by ${userName}`
    );

    console.log(
      "Destination:",
      group.tripPlan.destination
    );

    console.log(
      "Route points:",
      group.tripPlan.routePoints.length
    );

    // Send updated plan to EVERYONE in the group
    io.to(groupCode).emit(
      "tripPlanUpdated",
      group.tripPlan
    );
  });

  // ====================================================
  // CLEAR TRIP PLAN
  // ====================================================

  socket.on("clearTripPlan", (data) => {
    const { groupCode } = data;

    if (!groups[groupCode]) {
      return;
    }

    groups[groupCode].tripPlan = null;

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

    // Everyone in the group receives SOS
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
  // DISCONNECT
  // ====================================================

  socket.on("disconnect", () => {
    console.log(
      "User disconnected:",
      socket.id
    );

    for (const groupCode in groups) {
      const group = groups[groupCode];

      const user = group.members.find(
        (member) =>
          member.socketId === socket.id
      );

      if (!user) {
        continue;
      }

      group.members = group.members.filter(
        (member) =>
          member.socketId !== socket.id
      );

      // Update member list
      io.to(groupCode).emit(
        "groupMembers",
        {
          members: group.members,
        }
      );

      // Notify group
      io.to(groupCode).emit(
        "userLeft",
        {
          userId: user.userId,
          userName: user.userName,
        }
      );

      console.log(
        `${user.userName} left ${groupCode}`
      );

      // Optional cleanup:
      // Delete empty groups.
      if (group.members.length === 0) {
        delete groups[groupCode];

        console.log(
          `Group ${groupCode} removed`
        );
      }

      break;
    }
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