import axios from "axios";

const HOUR_MS = 60 * 60 * 1000;

let cachedRate: { value: number; expiresAt: number } | null = null;

export const usdToInr = async () => {
  if (cachedRate && Date.now() < cachedRate.expiresAt) return cachedRate.value;

  try {
    const response = await axios.get(
      "https://api.frankfurter.app/latest?from=USD&to=INR",
      { timeout: 5000 },
    );
    const rate = Number(response.data?.rates?.INR);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("USD to INR rate was missing");
    }
    cachedRate = { value: rate, expiresAt: Date.now() + HOUR_MS };
    return rate;
  } catch (error) {
    if (cachedRate) return cachedRate.value;
    throw error;
  }
};
