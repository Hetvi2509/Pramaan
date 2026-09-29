import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

const SECRET = process.env.JWT_SECRET || "pramaan-dev-secret-change-me";

export function signToken(userId: number) {
  return jwt.sign({ userId }, SECRET, { expiresIn: "7d" });
}

export interface AuthedRequest extends Request {
  userId?: number;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  // <video>/<img> tags can't set headers, so media routes also accept ?token= for the same JWT.
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string) || null;
  if (!token) return res.status(401).json({ success: false, error: "Missing token" });
  try {
    const payload = jwt.verify(token, SECRET) as { userId: number };
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}
