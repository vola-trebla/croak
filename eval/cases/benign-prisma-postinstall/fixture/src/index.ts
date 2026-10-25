// SYNTHETIC croak eval fixture (croak-eval-synthetic). Benign by design.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
console.log(await prisma.user.count());
