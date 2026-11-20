# No `credentials = file(...)`: the provider uses Application Default Credentials.
#   - Locally:  gcloud auth application-default login, optionally with
#               GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=<terraform-deployer SA> (short-lived tokens, no key file)
#   - CI/CD:    Workload Identity Federation (e.g. google-github-actions/auth), no key file
provider "google" {
  project = var.project_id
  region  = var.region

  default_labels = {
    managed-by = "terraform"
  }
}
