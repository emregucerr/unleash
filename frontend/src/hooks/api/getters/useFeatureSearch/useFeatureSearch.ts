import useSWR, { SWRConfiguration } from 'swr';
import { useCallback } from 'react';
import { IFeatureToggleListItem } from 'interfaces/featureToggle';
import { formatApiPath } from 'utils/formatPath';
import handleErrorResponses from '../httpErrorResponseHandler';

type IFeatureSearchResponse = { features: IFeatureToggleListItem[] };

interface IUseFeatureSearchOutput {
    features: IFeatureToggleListItem[];
    loading: boolean;
    error: string;
    refetch: () => void;
}

const fallbackFeatures: { features: IFeatureToggleListItem[] } = {
    features: [],
};

export const useFeatureSearch = (
    cursor: string,
    options: SWRConfiguration = {},
): IUseFeatureSearchOutput => {
    const { KEY, fetcher } = getFeatureSearchFetcher(cursor);
    const { data, error, mutate } = useSWR<IFeatureSearchResponse>(
        KEY,
        fetcher,
        options,
    );

    const refetch = useCallback(() => {
        mutate();
    }, [mutate]);

    return {
        features: data?.features || fallbackFeatures.features,
        loading: !error && !data,
        error,
        refetch,
    };
};

const getFeatureSearchFetcher = (cursor: string) => {
    const fetcher = () => {
        const path = formatApiPath(`api/admin/search/features?cursor=${cursor}`);
        return fetch(path, {
            method: 'GET',
        })
            .then(handleErrorResponses('Feature search'))
            .then((res) => res.json());
    };

    const KEY = `api/admin/search/features?cursor=${cursor}`;

    return {
        fetcher,
        KEY,
    };
};
