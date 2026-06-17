import { PaymentStatus } from '@prisma/client';
import { prisma } from '../db';

export class PaymentService {
  async getPayment(paymentId: string) {
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId },
      include: { userWallet: true },
    });
    if (!payment) throw new Error('Payment not found');

    return {
      id: payment.id,
      userId: payment.userId,
      network: payment.network,
      token: payment.token,
      address: payment.userWallet!.address,
      receivedAmount: payment.receivedAmount.toString(),
      feeAmount: payment.feeAmount.toString(),
      status: payment.status,
      txHash: payment.txHash,
      sweepTxHash: payment.sweepTxHash ?? undefined,
      confirmations: payment.confirmations,
      completedAt: payment.completedAt?.toISOString(),
      createdAt: payment.createdAt.toISOString(),
    };
  }

  async listPayments(page = 1, limit = 20, status?: PaymentStatus, userId?: string) {
    const where = {
      ...(status && { status }),
      ...(userId && { userId }),
    };
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { userWallet: { select: { address: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);

    return {
      data: payments.map((p) => ({
        id: p.id,
        userId: p.userId,
        network: p.network,
        token: p.token,
        address: p.userWallet!.address,
        receivedAmount: p.receivedAmount.toString(),
        feeAmount: p.feeAmount.toString(),
        status: p.status,
        txHash: p.txHash,
        confirmations: p.confirmations,
        completedAt: p.completedAt?.toISOString(),
        createdAt: p.createdAt.toISOString(),
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  async onPaymentConfirmed(paymentId: string): Promise<void> {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CONFIRMED },
    });
  }

  async onSweepCompleted(paymentId: string, sweepTxHash: string, feeAmount: bigint): Promise<void> {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.COMPLETED,
        sweepTxHash,
        feeAmount: feeAmount.toString(),
        completedAt: new Date(),
      },
    });
  }
}

export const paymentService = new PaymentService();
