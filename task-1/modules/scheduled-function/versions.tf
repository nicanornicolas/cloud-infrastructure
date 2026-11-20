terraform {
  # 1.7+ for `terraform test` mock providers used in ./tests.
  required_version = ">= 1.7"

  required_providers {
    google = {
      source = "hashicorp/google"
      # Modules declare a minimum; the root module pins the exact range and the lock file pins the build.
      version = ">= 8.0, < 9.0"
    }
  }
}
