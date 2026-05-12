require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("DB ERROR:", err));

app.get("/", (req, res) => {
  res.send("Backend running");
});

function generateGroupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const groups = {};

app.post("/api/group/create", (req, res) => {
  const groupCode = generateGroupCode();

  groups[groupCode] = {
    members: {},
    createdAt: new Date()
  };

  console.log("Group created:", groupCode);

  res.json({ groupCode });
});

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("joinGroup", (data) => {
    const { groupCode, userId, userName } = data;

    socket.join(groupCode);

    // CREATE GROUP IF NOT EXISTS
    if (!groups[groupCode]) {
      groups[groupCode] = [];
    }

    // PREVENT DUPLICATES
    const exists = groups[groupCode].find(
      (u) => u.userId === userId
    );

    if (!exists) {
      groups[groupCode].push({
        userId,
        userName,
      });
    }

    console.log(`${userName} joined ${groupCode}`);

    // SEND MEMBERS TO ROOM
    io.to(groupCode).emit("groupMembers", {
      members: groups[groupCode],
    });

    // SEND JOIN NOTIFICATION
    io.to(groupCode).emit("userJoined", {
      userId,
      userName,
    });

    // SEND GROUP CREATED
    socket.emit("groupCreated", {
      groupCode,
    });
  });

  // LOCATION
  socket.on("sendLocation", (data) => {
    socket.to(data.groupCode).emit(
      "receiveLocation",
      data
    );
  });

  // SOS
  socket.on("sendSOS", (data) => {
    io.to(data.groupCode).emit(
      "receiveSOS",
      data
    );
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});