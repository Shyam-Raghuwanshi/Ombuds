import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * A judge opens the URL knowing nothing, with no account. If they see a sign-up
 * form we have lost judging criterion 5. Anonymous is the default path and is
 * signed in silently; Password is optional and only for a family that wants to
 * come back to a search later.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Anonymous, Password],
});
