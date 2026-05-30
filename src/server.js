const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;

// ================= GROUP STORAGE =================

const groups = {};

// ================= SOCKET =================

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // JOIN GROUP
  socket.on("joinGroup", (data) => {
    const { groupCode, userId, userName } = data;

    socket.join(groupCode);

    if (!groups[groupCode]) {
      groups[groupCode] = [];
    }

    // remove old duplicate
    groups[groupCode] = groups[groupCode].filter(
      (u) => u.userId !== userId
    );

    groups[groupCode].push({
      socketId: socket.id,
      userId,
      userName,
    });

    console.log(`${userName} joined ${groupCode}`);

    // SEND MEMBERS
    io.to(groupCode).emit("groupMembers", {
      members: groups[groupCode],
    });

    // NOTIFY USERS
    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    // GROUP CREATED
    io.to(groupCode).emit("groupCreated", {
      groupCode,
    });
  });

  // LIVE LOCATION
  socket.on("sendLocation", (data) => {
    socket.to(data.groupCode).emit("receiveLocation", data);
  });

  // SOS
  socket.on("sendSOS", (data) => {
    io.to(data.groupCode).emit("receiveSOS", data);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    for (const groupCode in groups) {
      const user = groups[groupCode].find(
        (u) => u.socketId === socket.id
      );

      if (user) {
        groups[groupCode] = groups[groupCode].filter(
          (u) => u.socketId !== socket.id
        );

        io.to(groupCode).emit("groupMembers", {
          members: groups[groupCode],
        });

        io.to(groupCode).emit("userLeft", {
          userId: user.userId,
          userName: user.userName,
        });

        console.log(`${user.userName} left ${groupCode}`);
      }
    }
  });
});

// ================= TEST ROUTE =================

app.get("/", (req, res) => {
  res.send("Ride Tracker Backend Running");
});

// ================= START =================

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});