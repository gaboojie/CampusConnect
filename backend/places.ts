export type PlacePhotoAttribution = {
  displayName: string;
  uri: string;
};

export type PlacePhoto = {
  url: string;
  authorAttributions: PlacePhotoAttribution[];
};

type PlaceDetailsResponse = {
  photos?: Array<{
    name?: string;
    authorAttributions?: Array<{
      displayName?: string;
      uri?: string;
    }>;
  }>;
};

type PlaceMediaResponse = {
  photoUri?: string;
};

const PLACES_API_ROOT = "https://places.googleapis.com/v1";
const MAX_PHOTOS = 3;

function normalizeUri(uri: string): string {
  return uri.startsWith("//") ? `https:${uri}` : uri;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Google Places returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export async function fetchPlacePhotos(
  placeId: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<PlacePhoto[]> {
  const detailsResponse = await fetcher(`${PLACES_API_ROOT}/places/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "photos",
    },
  });
  const details = await readJson<PlaceDetailsResponse>(detailsResponse);
  const photoMetadata = (details.photos ?? []).filter((photo) => photo.name).slice(0, MAX_PHOTOS);
  const photos: PlacePhoto[] = [];

  for (const photo of photoMetadata) {
    try {
      const mediaResponse = await fetcher(
        `${PLACES_API_ROOT}/${photo.name}/media?maxWidthPx=800&skipHttpRedirect=true`,
        { headers: { "X-Goog-Api-Key": apiKey } },
      );
      const media = await readJson<PlaceMediaResponse>(mediaResponse);
      if (!media.photoUri) continue;

      const authorAttributions = (photo.authorAttributions ?? [])
        .filter((attribution) => attribution.displayName && attribution.uri)
        .map((attribution) => ({
          displayName: attribution.displayName!,
          uri: normalizeUri(attribution.uri!),
        }));

      photos.push({
        url: media.photoUri,
        authorAttributions,
      });
    } catch {
      // One unavailable photo should not prevent the remaining photos from loading.
    }
  }

  return photos;
}
