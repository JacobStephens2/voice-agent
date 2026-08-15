import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type { PasskeyAdapter, StoredPasskey } from "./index.ts";

export interface SimpleWebAuthnPasskeyAdapterOptions {
  readonly origin: string;
  readonly rpId: string;
  readonly rpName: string;
}

export function createSimpleWebAuthnPasskeyAdapter(
  config: SimpleWebAuthnPasskeyAdapterOptions,
): PasskeyAdapter {
  return {
    async beginAuthentication({ credentials }) {
      const options = await generateAuthenticationOptions({
        allowCredentials: credentials.map((credential) => ({
          id: credential.credentialId,
          transports: transports(credential.transports),
        })),
        rpID: config.rpId,
        userVerification: "required",
      });
      return { challenge: options.challenge, options };
    },
    async beginRegistration({ existingCredentials, ownerUserId }) {
      const options = await generateRegistrationOptions({
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        excludeCredentials: existingCredentials.map((credential) => ({
          id: credential.credentialId,
          transports: transports(credential.transports),
        })),
        rpID: config.rpId,
        rpName: config.rpName,
        userDisplayName: "Owner",
        userID: new TextEncoder().encode(ownerUserId),
        userName: "owner",
      });
      return { challenge: options.challenge, options };
    },
    async finishAuthentication({
      credentials,
      expectedChallenge,
      response,
    }) {
      const parsed = authenticationResponse(response);
      const stored = credentials.find(
        (credential) => credential.credentialId === parsed.id,
      );
      if (stored === undefined) throw new Error("Passkey is not enrolled");
      const verification = await verifyAuthenticationResponse({
        credential: webAuthnCredential(stored),
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: true,
        response: parsed,
      });
      if (!verification.verified) {
        throw new Error("Passkey authentication could not be verified");
      }
      return {
        credentialId: stored.credentialId,
        newCounter: verification.authenticationInfo.newCounter,
      };
    },
    async finishRegistration({ expectedChallenge, response }) {
      const parsed = registrationResponse(response);
      const verification = await verifyRegistrationResponse({
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
        response: parsed,
      });
      if (!verification.verified) {
        throw new Error("Passkey registration could not be verified");
      }
      const info = verification.registrationInfo;
      return {
        backedUp: info.credentialBackedUp,
        counter: info.credential.counter,
        credentialId: info.credential.id,
        deviceType: info.credentialDeviceType,
        publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
        transports: parsed.response.transports ?? [],
      };
    },
  };
}

function authenticationResponse(response: unknown): AuthenticationResponseJSON {
  if (
    typeof response !== "object" ||
    response === null ||
    !("id" in response) ||
    typeof response.id !== "string"
  ) {
    throw new Error("Passkey authentication response is invalid");
  }
  return response as AuthenticationResponseJSON;
}

function registrationResponse(response: unknown): RegistrationResponseJSON {
  if (
    typeof response !== "object" ||
    response === null ||
    !("id" in response) ||
    typeof response.id !== "string"
  ) {
    throw new Error("Passkey registration response is invalid");
  }
  return response as RegistrationResponseJSON;
}

function transports(
  values: readonly string[],
): AuthenticatorTransportFuture[] {
  return values.filter(isTransport);
}

function isTransport(value: string): value is AuthenticatorTransportFuture {
  return ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(
    value,
  );
}

function webAuthnCredential(passkey: StoredPasskey) {
  return {
    counter: passkey.counter,
    id: passkey.credentialId,
    publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
    transports: transports(passkey.transports),
  };
}
