import { createFileRoute } from "@tanstack/react-router";

import { PullRequestInbox } from "../components/pullRequestInbox/PullRequestInbox";

export const Route = createFileRoute("/_chat/my-pull-requests")({
  component: PullRequestInbox,
});
